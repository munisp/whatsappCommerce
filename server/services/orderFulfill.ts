/**
 * === W43 fulfillment (Coder A): partial fulfillment =======================
 *
 * Merchants can fulfill a SUBSET of order lines (and partial quantities).
 *
 * Guarantees (SPEC_W43):
 *   - Claim-first qty guard: order lines are locked SELECT ... FOR UPDATE
 *     inside the transaction, then the requested qty is checked against
 *     ordered-minus-already-fulfilled. A concurrent fulfill of the same line
 *     serializes on the row lock and loses the guard — no over-fulfillment.
 *   - Idempotent: the fulfillment key (fulfillmentId + orderLineId) is a
 *     unique index on order_fulfillment_lines; replaying the same
 *     fulfillmentId returns the original fulfillment without touching stock
 *     or lines a second time.
 *   - Stock-reservation decrement exactly once: fulfilling consumes the
 *     COMMITTED inventory_reservations rows for (orderId, productId) — the
 *     units already left products.stockQuantity at reserve time, so the
 *     reservation ledger is decremented (rows fully consumed flip to
 *     'fulfilled'), NEVER restocked.
 *   - Derived order status: 'partially_fulfilled' when some-but-not-all
 *     lines are fully fulfilled; 'shipped' when every line is fulfilled.
 *
 * Customer notification goes through channelParity.sendCustomerText with
 * category 'partial_fulfillment' (registered in channelParity.ts) so it
 * lands on WhatsApp AND Telegram.
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  inventoryReservations,
  orderFulfillmentLines,
  orderFulfillments,
  orderItems,
  orders,
  tenants,
  type OrderFulfillment,
} from "../../drizzle/schema";
import { assertTenantActive } from "./tenantGuard";
import type { TxHandle } from "./inventory";
// === W43 exchanges (Coder B) merger seam: stock-adjustment audit ===
import { recordStockAdjustment } from "./stockAdjustments";

interface DbLike extends TxHandle {
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

export interface FulfillLineInput {
  orderLineId: string;
  qty: number;
}

export interface FulfillResult {
  fulfillment: OrderFulfillment;
  lines: { orderLineId: string; qty: number }[];
  orderStatus: string;
  /** True when this call replayed an already-recorded fulfillmentId. */
  replayed: boolean;
}

const FULFILLABLE_ORDER_STATUSES = ["confirmed", "processing", "partially_fulfilled"];

/**
 * Fulfill a subset of an order's lines. See module header for guarantees.
 */
export async function fulfillOrderLines(
  db: DbLike,
  opts: {
    tenantId: string;
    orderId: string;
    lines: FulfillLineInput[];
    /** Caller-supplied idempotency key; generated when omitted. */
    fulfillmentId?: string;
    trackingCarrier?: string;
    trackingNumber?: string;
    /** Test seam: override customer notify (defaults to channelParity both-channel send). */
    notify?: (tenantId: string, customerRef: string, category: string, text: string) => Promise<unknown>;
  },
): Promise<FulfillResult> {
  if (!opts.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No lines to fulfill" });
  }
  for (const l of opts.lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid fulfill qty ${l.qty} for line ${l.orderLineId}` });
    }
  }
  const [tenant] = await db
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  if (tenant) assertTenantActive(tenant);

  const fulfillmentId = opts.fulfillmentId ?? randomUUID();
  const now = new Date();

  const result = await db.transaction(async (tx): Promise<FulfillResult> => {
    // Idempotent replay: a fulfillment with this key already exists → return
    // it verbatim. No second stock decrement, no second line insert.
    const [existing] = await tx
      .select()
      .from(orderFulfillments)
      .where(and(eq(orderFulfillments.id, fulfillmentId), eq(orderFulfillments.tenantId, opts.tenantId)))
      .limit(1);
    if (existing) {
      const existingLines = await tx
        .select({ orderLineId: orderFulfillmentLines.orderLineId, qty: orderFulfillmentLines.qty })
        .from(orderFulfillmentLines)
        .where(eq(orderFulfillmentLines.fulfillmentId, existing.id));
      const [ord] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, existing.orderId)).limit(1);
      return { fulfillment: existing, lines: existingLines, orderStatus: ord?.status ?? "", replayed: true };
    }

    // Lock the order row, then the line rows — claim-first.
    const [order] = (await tx.execute(sql`
      SELECT "id", "tenantId", "status", "customerId", "orderNumber"
      FROM "orders" WHERE "id" = ${opts.orderId} AND "tenantId" = ${opts.tenantId}
      FOR UPDATE
    `)) as any[];
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
    if (!FULFILLABLE_ORDER_STATUSES.includes(order.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Order in status '${order.status}' cannot be fulfilled`,
      });
    }

    const lineRows = (await tx.execute(sql`
      SELECT "id", "productId", "quantity", "status"
      FROM "order_items" WHERE "orderId" = ${opts.orderId}
      ORDER BY "id"
      FOR UPDATE
    `)) as any[];
    const lineById = new Map(lineRows.map((r: any) => [r.id, r]));

    // Already-fulfilled qty per line (all non-cancelled fulfillments of this order).
    const fulfilledRows = (await tx.execute(sql`
      SELECT ofl."orderLineId" AS "orderLineId", COALESCE(SUM(ofl."qty"), 0)::int AS "fulfilledQty"
      FROM "order_fulfillment_lines" ofl
      JOIN "order_fulfillments" f ON f."id" = ofl."fulfillmentId"
      WHERE f."orderId" = ${opts.orderId} AND f."status" <> 'cancelled'
      GROUP BY ofl."orderLineId"
    `)) as any[];
    const fulfilledByLine = new Map(fulfilledRows.map((r: any) => [r.orderLineId, Number(r.fulfilledQty)]));

    // Qty guard: cannot fulfill more than ordered minus already-fulfilled.
    for (const l of opts.lines) {
      const line = lineById.get(l.orderLineId) as any;
      if (!line) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Order line ${l.orderLineId} not found on order ${opts.orderId}` });
      }
      const remaining = Number(line.quantity) - (fulfilledByLine.get(l.orderLineId) ?? 0);
      if (l.qty > remaining) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot fulfill ${l.qty} of line ${l.orderLineId}: only ${remaining} of ${line.quantity} remaining`,
        });
      }
    }

    await tx.insert(orderFulfillments).values({
      id: fulfillmentId,
      orderId: opts.orderId,
      tenantId: opts.tenantId,
      status: "pending",
      trackingCarrier: opts.trackingCarrier ?? null,
      trackingNumber: opts.trackingNumber ?? null,
      createdAt: now,
      updatedAt: now,
    });
    for (const l of opts.lines) {
      // Unique (fulfillmentId, orderLineId) — the idempotency key.
      await tx.insert(orderFulfillmentLines).values({
        id: randomUUID(),
        fulfillmentId,
        orderLineId: l.orderLineId,
        qty: l.qty,
        createdAt: now,
      });
      // Consume committed reservations for (order, product) — claim-first:
      // rows locked FOR UPDATE inside this txn, decremented (never restocked),
      // fully-consumed rows flip to 'fulfilled'. If the caller replays, the
      // early-return above guarantees this runs exactly once.
      const line = lineById.get(l.orderLineId) as any;
      let need = l.qty;
      const committed = (await tx.execute(sql`
        SELECT "id", "qty" FROM "inventory_reservations"
        WHERE "orderId" = ${opts.orderId} AND "productId" = ${line.productId} AND "status" = 'committed'
        ORDER BY "createdAt"
        FOR UPDATE
      `)) as any[];
      for (const r of committed) {
        if (need <= 0) break;
        const take = Math.min(Number(r.qty), need);
        if (take === Number(r.qty)) {
          await tx.update(inventoryReservations)
            .set({ status: "fulfilled" })
            .where(and(eq(inventoryReservations.id, r.id), eq(inventoryReservations.status, "committed")));
        } else {
          await tx.update(inventoryReservations)
            .set({ qty: sql`${inventoryReservations.qty} - ${take}` })
            .where(and(eq(inventoryReservations.id, r.id), eq(inventoryReservations.status, "committed")));
        }
        need -= take;
      }
      // Note: no committed reservation (unpaid/manual orders) is NOT an
      // error — stock for those orders was never in the reservation ledger.
      // === W43 exchanges (Coder B) merger seam: audit the fulfillment stock
      // consumption in the SAME txn (one row per fulfillment line). Throws
      // on bad input → the fulfillment rolls back with it (fail-closed). ===
      await recordStockAdjustment(tx, {
        tenantId: opts.tenantId,
        productId: line.productId,
        deltaQty: -l.qty,
        reason: "other",
        refType: "fulfillment",
        refId: fulfillmentId,
        note: `fulfill ${l.qty} of order line ${l.orderLineId}`,
      });
    }

    // Derived order status: fully fulfilled → 'shipped'; partial →
    // 'partially_fulfilled' (additive enum value, mig 0130).
    let allFulfilled = true;
    let anyFulfilled = false;
    for (const r of lineRows as any[]) {
      const done = (fulfilledByLine.get(r.id) ?? 0) + (opts.lines.find((l) => l.orderLineId === r.id)?.qty ?? 0);
      if (done > 0) anyFulfilled = true;
      if (done < Number(r.quantity)) allFulfilled = false;
    }
    const derivedStatus = allFulfilled ? "shipped" : anyFulfilled ? "partially_fulfilled" : order.status;
    const fulfillmentStatus = allFulfilled ? "complete" : "partial";

    await tx.update(orderFulfillments)
      .set({ status: fulfillmentStatus, updatedAt: now })
      .where(eq(orderFulfillments.id, fulfillmentId));

    if (derivedStatus !== order.status) {
      const transitioned = await tx.update(orders)
        .set({ status: derivedStatus as any, updatedAt: now })
        .where(and(eq(orders.id, opts.orderId), eq(orders.status, order.status)))
        .returning({ id: orders.id });
      if (transitioned.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Order status changed concurrently — fulfillment aborted",
        });
      }
    }

    const [fulfillment] = await tx.select().from(orderFulfillments).where(eq(orderFulfillments.id, fulfillmentId));
    return {
      fulfillment,
      lines: opts.lines.map((l) => ({ orderLineId: l.orderLineId, qty: l.qty })),
      orderStatus: derivedStatus,
      replayed: false,
      // carried for the post-txn notify below
      ...( { __order: order } as any),
    } as FulfillResult;
  });

  // Post-transaction notify (fire-and-forget, fail-open): WhatsApp AND
  // Telegram via the channelParity registry category 'partial_fulfillment'.
  const order = (result as any).__order;
  if (order?.customerId) {
    const noun = result.orderStatus === "shipped" ? "is on its way" : "was partially fulfilled";
    const text =
      `📦 Order ${order.orderNumber}: ${opts.lines.length} line(s) ${noun}.` +
      (opts.trackingNumber ? ` Tracking: ${opts.trackingCarrier ?? ""} ${opts.trackingNumber}`.trim() : "");
    const notify = opts.notify ?? (async (tenantId: string, ref: string, category: string, body: string) => {
      const { sendCustomerText } = await import("./channelParity");
      return sendCustomerText(tenantId, ref, category, body, { notifType: "order_status", orderId: opts.orderId });
    });
    await notify(opts.tenantId, order.customerId, "partial_fulfillment", text)
      .catch((e: unknown) => console.warn("[orderFulfill] notify failed:", (e as Error)?.message));
  }

  return result;
}
