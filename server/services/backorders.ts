/**
 * === W43 fulfillment (Coder A): backorders ================================
 *
 * When stock is insufficient at confirm AND the tenant has
 * tenants.allowBackorders = true (migration 0131, default false), the short
 * order line is marked 'backordered' instead of blocking checkout and a
 * backorder_requests row records the open demand.
 *
 * On inventory restock, open requests for that SKU are auto-filled
 * OLDEST-FIRST within the same transaction:
 *   - products.stockQuantity is decremented for the filled units and a
 *     'committed' inventory reservation is written for the backordered order
 *     (the units are now earmarked for that order — same ledger shape as a
 *     paid order after paymentConfirm).
 *   - the request flips to 'partially_filled' / 'filled'; a fully filled
 *     line returns to order_items.status = 'ordered'.
 *   - the customer is notified via channelParity.sendCustomerText with
 *     category 'backorder_filled' (registered in channelParity.ts) → the
 *     notice lands on WhatsApp AND Telegram.
 *
 * Idempotency: a partial unique index guarantees at most one open request
 * per order line, so a checkout retry never duplicates demand; the fill loop
 * claims request rows FOR UPDATE inside the caller's transaction so racing
 * restocks serialize.
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  backorderRequests,
  inventoryReservations,
  orderItems,
  orders,
  products,
  tenants,
} from "../../drizzle/schema";
import { assertTenantActive } from "./tenantGuard";
import { RESERVATION_TTL_MS, type TxHandle } from "./inventory";
// === W43 exchanges (Coder B) merger seam: stock-adjustment audit ===
import { recordStockAdjustment } from "./stockAdjustments";

interface DbLike extends TxHandle {
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

type NotifyFn = (tenantId: string, customerRef: string, category: string, text: string) => Promise<unknown>;

async function defaultNotify(tenantId: string, ref: string, category: string, text: string): Promise<unknown> {
  const { sendCustomerText } = await import("./channelParity");
  return sendCustomerText(tenantId, ref, category, text, { notifType: "order_status" });
}

/** Read the tenant's allowBackorders flag (false when the row is missing). */
export async function isBackordersEnabled(db: TxHandle, tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ allowBackorders: tenants.allowBackorders })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as { allowBackorders: boolean }[]);
  return row?.allowBackorders === true;
}

/**
 * Mark an order line backordered and record the open demand. Idempotent:
 * if an open request already exists for the line its qty is topped up
 * instead of inserting a duplicate (the partial unique index is the hard
 * guarantee; the FOR UPDATE re-check is the race-free read).
 */
export async function markLineBackordered(
  db: DbLike,
  opts: { tenantId: string; orderLineId: string; qty: number },
): Promise<{ backorderId: string; created: boolean }> {
  if (!Number.isInteger(opts.qty) || opts.qty <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid backorder qty ${opts.qty}` });
  }
  const [tenant] = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  if (tenant) assertTenantActive(tenant);

  return db.transaction(async (tx) => {
    const [line] = (await tx.execute(sql`
      SELECT li."id", li."productId", o."tenantId" AS "tenantId"
      FROM "order_items" li
      JOIN "orders" o ON o."id" = li."orderId"
      WHERE li."id" = ${opts.orderLineId} AND o."tenantId" = ${opts.tenantId}
      FOR UPDATE OF li
    `)) as any[];
    if (!line) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Order line ${opts.orderLineId} not found` });
    }

    const [open] = (await tx.execute(sql`
      SELECT "id", "qty" FROM "backorder_requests"
      WHERE "orderLineId" = ${opts.orderLineId} AND "status" IN ('open','partially_filled')
      LIMIT 1
      FOR UPDATE
    `)) as any[];
    let backorderId: string;
    let created = false;
    if (open) {
      backorderId = open.id;
      await tx.update(backorderRequests)
        .set({ qty: sql`${backorderRequests.qty} + ${opts.qty}`, updatedAt: new Date() })
        .where(eq(backorderRequests.id, open.id));
    } else {
      backorderId = randomUUID();
      await tx.insert(backorderRequests).values({
        id: backorderId,
        tenantId: opts.tenantId,
        orderLineId: opts.orderLineId,
        productId: line.productId,
        qty: opts.qty,
        filledQty: 0,
        status: "open",
      });
      created = true;
    }
    await tx.update(orderItems)
      .set({ status: "backordered" })
      .where(eq(orderItems.id, opts.orderLineId));
    return { backorderId, created };
  });
}

export interface BackorderFill {
  backorderId: string;
  orderLineId: string;
  orderId: string;
  customerRef: string;
  orderNumber: string;
  filledQty: number;
  fullyFilled: boolean;
}

/**
 * Fill open backorders for one SKU oldest-first. MUST run inside the
 * caller's transaction alongside the stock mutation. Decrements
 * products.stockQuantity for the filled units (claim-first: the product row
 * is locked FOR UPDATE) and writes a 'committed' reservation per filled
 * order. Returns the fills for post-transaction notification.
 */
export async function fillBackordersForProductTx(
  tx: TxHandle,
  tenantId: string,
  productId: string,
  now: Date = new Date(),
): Promise<BackorderFill[]> {
  const [product] = (await tx.execute(sql`
    SELECT "id", "stockQuantity" FROM "products"
    WHERE "id" = ${productId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `)) as any[];
  if (!product) return [];
  let available = Number(product.stockQuantity ?? 0);
  if (available <= 0) return [];

  const open = (await tx.execute(sql`
    SELECT "id", "orderLineId", "qty", "filledQty"
    FROM "backorder_requests"
    WHERE "tenantId" = ${tenantId} AND "productId" = ${productId}
      AND "status" IN ('open','partially_filled')
    ORDER BY "createdAt", "id"
    FOR UPDATE
  `)) as any[];
  if (open.length === 0) return [];

  const fills: BackorderFill[] = [];
  let consumed = 0;
  for (const req of open) {
    if (available - consumed <= 0) break;
    const outstanding = Number(req.qty) - Number(req.filledQty);
    const take = Math.min(outstanding, available - consumed);
    if (take <= 0) continue;
    const fullyFilled = take === outstanding;
    await tx.update(backorderRequests)
      .set({
        filledQty: sql`${backorderRequests.filledQty} + ${take}`,
        status: fullyFilled ? "filled" : "partially_filled",
        filledAt: fullyFilled ? now : null,
        updatedAt: now,
      })
      .where(eq(backorderRequests.id, req.id));

    const [line] = (await tx.execute(sql`
      SELECT li."orderId" AS "orderId", o."customerId" AS "customerId", o."orderNumber" AS "orderNumber"
      FROM "order_items" li JOIN "orders" o ON o."id" = li."orderId"
      WHERE li."id" = ${req.orderLineId}
    `)) as any[];
    // Earmark the units for the backordered order: committed reservation,
    // same ledger shape as a paid order.
    await tx.insert(inventoryReservations).values({
      id: randomUUID(),
      tenantId,
      orderId: line.orderId,
      productId,
      qty: take,
      status: "committed",
      expiresAt: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
      createdAt: now,
    });
    if (fullyFilled) {
      await tx.update(orderItems)
        .set({ status: "ordered" })
        .where(eq(orderItems.id, req.orderLineId));
    }
    // === W43 exchanges (Coder B) merger seam: audit the backorder-fill stock
    // earmark in the SAME txn (reason backorder_fill, ref = request id). ===
    await recordStockAdjustment(tx, {
      tenantId,
      productId,
      deltaQty: -take,
      reason: "backorder_fill",
      refType: "backorder",
      refId: req.id,
      note: `backorder auto-fill ${take} unit(s) for order ${line.orderId}`,
    });
    consumed += take;
    fills.push({
      backorderId: req.id,
      orderLineId: req.orderLineId,
      orderId: line.orderId,
      customerRef: line.customerId,
      orderNumber: line.orderNumber,
      filledQty: take,
      fullyFilled,
    });
  }

  if (consumed > 0) {
    await tx.update(products)
      .set({ stockQuantity: sql`${products.stockQuantity} - ${consumed}`, updatedAt: now })
      .where(eq(products.id, productId));
  }
  return fills;
}

/**
 * Checkout confirm path (tenants.allowBackorders = true): for each item,
 * reserve what stock exists and backorder the remainder instead of throwing
 * InsufficientStockError. MUST run inside the caller's order transaction —
 * the product rows are locked FOR UPDATE so concurrent checkouts serialize
 * and can never oversell. Lines with a shortfall are marked 'backordered'
 * and get exactly one open backorder_request (partial unique index).
 */
export async function reserveStockWithBackorders(
  tx: TxHandle,
  tenantId: string,
  orderId: string,
  items: { productId: string; qty: number; orderLineId: string }[],
  now: Date = new Date(),
): Promise<{ reserved: number; backordered: number }> {
  let reserved = 0;
  let backordered = 0;
  for (const item of items) {
    const [product] = (await tx.execute(sql`
      SELECT "id", "stockQuantity" FROM "products"
      WHERE "id" = ${item.productId} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `)) as any[];
    const onHand = Math.max(0, Number(product?.stockQuantity ?? 0));
    const reserveQty = Math.min(item.qty, onHand);
    const shortQty = item.qty - reserveQty;

    if (reserveQty > 0) {
      await tx.update(products)
        .set({ stockQuantity: sql`${products.stockQuantity} - ${reserveQty}`, updatedAt: now })
        .where(eq(products.id, item.productId));
      await tx.insert(inventoryReservations).values({
        id: randomUUID(),
        tenantId,
        orderId,
        productId: item.productId,
        qty: reserveQty,
        status: "reserved",
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
        createdAt: now,
      });
      reserved++;
    }
    if (shortQty > 0) {
      await tx.insert(backorderRequests).values({
        id: randomUUID(),
        tenantId,
        orderLineId: item.orderLineId,
        productId: item.productId,
        qty: shortQty,
        filledQty: 0,
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
      await tx.update(orderItems)
        .set({ status: "backordered" })
        .where(eq(orderItems.id, item.orderLineId));
      backordered++;
    }
  }
  return { reserved, backordered };
}

/**
 * The restock path: add stock for a SKU and auto-fill its open backorders
 * oldest-first IN THE SAME TRANSACTION, then notify each affected customer
 * on both channels (category 'backorder_filled'). Returns the fills.
 */
export async function restockAndFillBackorders(
  db: DbLike,
  opts: { tenantId: string; productId: string; qty: number; notify?: NotifyFn },
): Promise<BackorderFill[]> {
  if (!Number.isInteger(opts.qty) || opts.qty <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid restock qty ${opts.qty}` });
  }
  const [tenant] = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  if (tenant) assertTenantActive(tenant);

  const now = new Date();
  const fills = await db.transaction(async (tx) => {
    const updated = await tx.update(products)
      .set({ stockQuantity: sql`${products.stockQuantity} + ${opts.qty}`, updatedAt: now })
      .where(and(eq(products.id, opts.productId), eq(products.tenantId, opts.tenantId)))
      .returning({ id: products.id });
    if (updated.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Product ${opts.productId} not found` });
    }
    return fillBackordersForProductTx(tx, opts.tenantId, opts.productId, now);
  });

  const notify = opts.notify ?? defaultNotify;
  for (const fill of fills) {
    const text = fill.fullyFilled
      ? `🎉 Good news! Your backordered item from order ${fill.orderNumber} is now back in stock and reserved for you.`
      : `📦 Part of your backordered item from order ${fill.orderNumber} is back in stock (${fill.filledQty} unit(s) reserved); we'll message you when the rest arrives.`;
    await notify(opts.tenantId, fill.customerRef, "backorder_filled", text)
      .catch((e: unknown) => console.warn("[backorders] notify failed:", (e as Error)?.message));
  }
  return fills;
}

/**
 * Restock seam for the EXISTING product-update path (routers/product.ts):
 * called fire-and-forget after a stock increase so open backorders for the
 * SKU are claimed oldest-first and customers notified. Never throws into the
 * caller (fail-open telemetry, fail-closed money: the fill itself ran in one
 * transaction).
 */
export async function fillBackordersAfterRestock(
  db: DbLike,
  tenantId: string,
  productId: string,
): Promise<BackorderFill[]> {
  try {
    const fills = await db.transaction(async (tx) => fillBackordersForProductTx(tx, tenantId, productId));
    for (const fill of fills) {
      const text = fill.fullyFilled
        ? `🎉 Good news! Your backordered item from order ${fill.orderNumber} is now back in stock and reserved for you.`
        : `📦 Part of your backordered item from order ${fill.orderNumber} is back in stock (${fill.filledQty} unit(s) reserved); we'll message you when the rest arrives.`;
      await defaultNotify(tenantId, fill.customerRef, "backorder_filled", text)
        .catch((e: unknown) => console.warn("[backorders] notify failed:", (e as Error)?.message));
    }
    return fills;
  } catch (e) {
    console.error("[backorders] post-restock fill error:", (e as Error)?.message);
    return [];
  }
}
