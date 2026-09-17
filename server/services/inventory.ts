/**
 * Inventory reservation service — the platform's "never take payment for
 * items that don't exist in stock" guard.
 *
 * Model (TigerBeetle-style two-phase, mirrored on PG rows):
 *   reserve  — atomic conditional decrement of products.stockQuantity
 *              (UPDATE ... WHERE stockQuantity >= qty RETURNING). If the
 *              conditional update matches zero rows the stock simply isn't
 *              there, so the whole order transaction is rolled back by
 *              throwing InsufficientStockError. A 'reserved' row with a
 *              15-minute TTL is written per (order, product).
 *   commit   — reserved → committed, called ONLY from the payment-confirm
 *              success path. Stock stays decremented (it left the building).
 *   release  — reserved → released with the stock credited back, via a
 *              claim-first conditional UPDATE so double-release (cancel +
 *              sweeper racing, webhook replays) is idempotent.
 *
 * All functions take the caller's db/tx handle so multi-statement flows run
 * inside ONE transaction (order insert + reserve) — no partial orders.
 */
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { getDb } from "../db";
import { inventoryReservations, orders, paymentIntents, products } from "../../drizzle/schema";
import { scheduleLowStockCheck } from "./lowStock";
// === W43 exchanges (Coder B): stock-adjustment audit (cancel-release path) ===
import { recordStockAdjustment } from "./stockAdjustments";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle mutation/query surface (db or tx). */
export type TxHandle = Pick<DbHandle, "select" | "selectDistinct" | "insert" | "update" | "execute">;

/** Reservation TTL — matches the pending-payment window pattern (900s). */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * ORD-3: hard cap on how long TTL extensions may keep a reservation alive.
 * A payment attempt in flight extends the TTL, but never past this age —
 * a buyer who never completes payment must eventually return the stock.
 */
export const RESERVATION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface ReserveItem {
  productId: string;
  qty: number;
}

export interface StockShortage {
  productId: string;
  name: string;
  requested: number;
  available: number;
}

export class InsufficientStockError extends Error {
  readonly shortages: StockShortage[];
  constructor(shortages: StockShortage[]) {
    super(
      `Insufficient stock: ${shortages
        .map((s) => `${s.name} (requested ${s.requested}, available ${s.available})`)
        .join("; ")}`,
    );
    this.name = "InsufficientStockError";
    this.shortages = shortages;
  }
}

/**
 * Read-only availability check (no locking). Used BEFORE order/payment-link
 * creation to give the buyer a clean "these items are unavailable" reply;
 * the authoritative guard is reserveStock's conditional UPDATE inside the
 * order transaction.
 */
export async function checkAvailability(
  db: TxHandle,
  tenantId: string,
  items: ReserveItem[],
): Promise<{ ok: boolean; shortages: StockShortage[] }> {
  const shortages: StockShortage[] = [];
  for (const item of items) {
    const [product] = await db
      .select({
        id: products.id,
        name: products.name,
        stockQuantity: products.stockQuantity,
      })
      .from(products)
      .where(and(eq(products.id, item.productId), eq(products.tenantId, tenantId)))
      .limit(1);
    const available = product?.stockQuantity ?? 0;
    if (!product || available < item.qty) {
      shortages.push({
        productId: item.productId,
        name: product?.name ?? item.productId,
        requested: item.qty,
        available,
      });
    }
  }
  return { ok: shortages.length === 0, shortages };
}

/**
 * Atomically reserve stock for an order. MUST be called inside the caller's
 * transaction: each item runs a conditional decrement that only succeeds
 * when enough stock exists; any failure throws InsufficientStockError so the
 * WHOLE order transaction (order row + all reservations) rolls back.
 */
export async function reserveStock(
  tx: TxHandle,
  tenantId: string,
  orderId: string,
  items: ReserveItem[],
  now: Date = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
  const shortages: StockShortage[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0) {
      throw new InsufficientStockError([
        { productId: item.productId, name: item.productId, requested: item.qty, available: 0 },
      ]);
    }
    // Atomic claim: the row is only updated when stockQuantity >= qty, so
    // concurrent checkouts can never drive stock negative or oversell the
    // last unit — exactly one of them claims it.
    const updated = await tx
      .update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${item.qty}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(products.id, item.productId),
          eq(products.tenantId, tenantId),
          sql`${products.stockQuantity} >= ${item.qty}`,
        ),
      )
      .returning({ id: products.id, name: products.name, stockQuantity: products.stockQuantity });

    if (updated.length === 0) {
      // Look up the current level for a useful error/reply, then bail — the
      // caller's transaction rolls back every reservation made so far.
      const [product] = await tx
        .select({ name: products.name, stockQuantity: products.stockQuantity })
        .from(products)
        .where(and(eq(products.id, item.productId), eq(products.tenantId, tenantId)))
        .limit(1);
      shortages.push({
        productId: item.productId,
        name: product?.name ?? item.productId,
        requested: item.qty,
        available: product?.stockQuantity ?? 0,
      });
      throw new InsufficientStockError(shortages);
    }

    // Low-stock admin alert (post-transaction, fire-and-forget): the check
    // re-reads COMMITTED state after this tx settles, so a rollback can never
    // produce a phantom alert, and errors are logged — never thrown.
    scheduleLowStockCheck(tenantId, item.productId);

    await tx.insert(inventoryReservations).values({
      id: randomUUID(),
      tenantId,
      orderId,
      productId: item.productId,
      qty: item.qty,
      status: "reserved",
      expiresAt,
      createdAt: now,
    });
  }
}

/**
 * reserved → committed. Called from the payment-confirm success path only,
 * after the order's payment was claimed. Stock stays decremented.
 * Idempotent: only 'reserved' rows transition.
 */
export async function commitReservations(
  db: TxHandle,
  orderId: string,
): Promise<number> {
  const committed = await db
    .update(inventoryReservations)
    .set({ status: "committed" })
    .where(
      and(
        eq(inventoryReservations.orderId, orderId),
        eq(inventoryReservations.status, "reserved"),
      ),
    )
    .returning({ id: inventoryReservations.id, tenantId: inventoryReservations.tenantId, productId: inventoryReservations.productId });
  // Low-stock admin alerts for the products whose stock just became final
  // (post-transaction, fire-and-forget — errors logged, never thrown).
  for (const row of committed) {
    scheduleLowStockCheck(row.tenantId, row.productId);
  }
  return committed.length;
}

/**
 * reserved → released with stock credited back (cancel / payment failure /
 * TTL expiry). Claim-first per row: the conditional UPDATE ... WHERE status
 * = 'reserved' RETURNING means exactly ONE concurrent release wins each row
 * and only the winner credits stock back — double-release is a no-op.
 * Returns the number of reservations released this call.
 */
export async function releaseReservations(
  db: TxHandle,
  orderId: string,
  now: Date = new Date(),
): Promise<number> {
  let released = 0;
  // Loop: each iteration claims one still-reserved row for this order.
  // Terminates because each successful claim flips one row out of 'reserved'.
  for (;;) {
    const claimed = await db
      .update(inventoryReservations)
      .set({ status: "released" })
      .where(
        and(
          eq(inventoryReservations.orderId, orderId),
          eq(inventoryReservations.status, "reserved"),
          sql`${inventoryReservations.id} = (
            SELECT "id" FROM "inventory_reservations"
            WHERE "orderId" = ${orderId} AND "status" = 'reserved'
            ORDER BY "createdAt"
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )`,
        ),
      )
      .returning({
        id: inventoryReservations.id,
        tenantId: inventoryReservations.tenantId,
        productId: inventoryReservations.productId,
        qty: inventoryReservations.qty,
      });
    if (claimed.length === 0) break;
    const row = claimed[0];
    await db
      .update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} + ${row.qty}`,
        updatedAt: now,
      })
      .where(eq(products.id, row.productId));
    // === W43 exchanges (Coder B): audit the cancel-release restock in the
    // SAME txn as the stock credit (append-only stock_adjustments row). ===
    await recordStockAdjustment(db, {
      tenantId: row.tenantId,
      productId: row.productId,
      deltaQty: row.qty,
      reason: "restock",
      refType: "reservation_release",
      refId: row.id,
      note: `Reservation released for order ${orderId} — stock credited back`,
    });
    // === END W43 exchanges ===
    released++;
  }
  return released;
}

/**
 * ORD-1: committed → released with stock credited back — the PAID-cancel
 * path. After payment confirmation the reservation rows are 'committed'
 * (stock left the pool for good); cancelling that paid order must put the
 * units back, which releaseReservations ('reserved'-only) deliberately does
 * NOT do. Same claim-first shape as releaseReservations: the conditional
 * UPDATE ... WHERE status = 'committed' RETURNING means exactly ONE caller
 * wins each row and only the winner restocks — a repeated cancel, a racing
 * expiry sweep, or a webhook replay is a no-op. Returns rows released.
 */
export async function releaseCommittedReservations(
  db: TxHandle,
  orderId: string,
  now: Date = new Date(),
): Promise<number> {
  let released = 0;
  // Loop: each iteration claims one still-committed row for this order.
  // Terminates because each successful claim flips one row out of 'committed'.
  for (;;) {
    const claimed = await db
      .update(inventoryReservations)
      .set({ status: "released" })
      .where(
        and(
          eq(inventoryReservations.orderId, orderId),
          eq(inventoryReservations.status, "committed"),
          sql`${inventoryReservations.id} = (
            SELECT "id" FROM "inventory_reservations"
            WHERE "orderId" = ${orderId} AND "status" = 'committed'
            ORDER BY "createdAt"
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )`,
        ),
      )
      .returning({
        id: inventoryReservations.id,
        tenantId: inventoryReservations.tenantId,
        productId: inventoryReservations.productId,
        qty: inventoryReservations.qty,
      });
    if (claimed.length === 0) break;
    const row = claimed[0];
    await db
      .update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} + ${row.qty}`,
        updatedAt: now,
      })
      .where(eq(products.id, row.productId));
    // === W43 exchanges (Coder B): audit the paid-cancel committed-release
    // restock in the SAME txn as the stock credit. ===
    await recordStockAdjustment(db, {
      tenantId: row.tenantId,
      productId: row.productId,
      deltaQty: row.qty,
      reason: "restock",
      refType: "committed_reservation_release",
      refId: row.id,
      note: `Committed reservation released for order ${orderId} (paid cancel) — stock credited back`,
    });
    // === END W43 exchanges ===
    scheduleLowStockCheck(row.tenantId, row.productId);
    released++;
  }
  return released;
}

/**
 * Expiry sweeper: release every 'reserved' row past its TTL whose order is
 * NOT paid. Idempotent by construction (releaseReservations is claim-first);
 * safe to run every 60s from the scheduled-job endpoint. Returns the number
 * of reservations released.
 *
 * ORD-3 (TTL-vs-webhook race): a reservation whose order has a payment
 * attempt IN FLIGHT (a paymentIntents row in 'initiated'/'pending' touched
 * within the last TTL window — the buyer is at the PSP checkout and the
 * webhook may just be slow) gets its TTL EXTENDED instead of released, so a
 * slow webhook can never land on an order whose stock was already resold.
 * Extensions are capped by RESERVATION_MAX_AGE (from createdAt, which never
 * changes) so an abandoned checkout cannot pin stock forever.
 */
export async function releaseExpiredReservations(
  db: TxHandle,
  now: Date = new Date(),
): Promise<{ orders: number; released: number; extended: number }> {
  const expired = await db
    .selectDistinct({ orderId: inventoryReservations.orderId })
    .from(inventoryReservations)
    .where(
      and(
        eq(inventoryReservations.status, "reserved"),
        lt(inventoryReservations.expiresAt, now),
      ),
    );

  let released = 0;
  let sweptOrders = 0;
  let extended = 0;
  for (const { orderId } of expired) {
    // Never release stock for a paid order — if the payment landed, the
    // reservation must be committed, not returned to the pool.
    const [order] = await db
      .select({ paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (order && order.paymentStatus === "completed") continue;

    // ORD-3: payment attempt in flight → extend the TTL, don't release.
    const attempts = await db
      .select({ updatedAt: paymentIntents.updatedAt })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.orderId, orderId),
          inArray(paymentIntents.status, ["initiated", "pending"]),
        ),
      );
    const lastAttemptAt = attempts.reduce(
      (max, a) => Math.max(max, new Date(a.updatedAt).getTime()),
      0,
    );
    if (lastAttemptAt > 0 && now.getTime() - lastAttemptAt < RESERVATION_TTL_MS) {
      // Claim-first extension: only still-reserved, still-expired rows younger
      // than the max-age cap are pushed out by one TTL; concurrent release is
      // impossible for rows this UPDATE claims.
      const rows = await db
        .update(inventoryReservations)
        .set({ expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS) })
        .where(
          and(
            eq(inventoryReservations.orderId, orderId),
            eq(inventoryReservations.status, "reserved"),
            lt(inventoryReservations.expiresAt, now),
            gt(inventoryReservations.createdAt, new Date(now.getTime() - RESERVATION_MAX_AGE_MS)),
          ),
        )
        .returning({ id: inventoryReservations.id });
      if (rows.length > 0) {
        extended += rows.length;
        continue;
      }
    }

    const n = await releaseReservations(db, orderId, now);
    if (n > 0) {
      sweptOrders++;
      released += n;
    }
  }
  return { orders: sweptOrders, released, extended };
}
