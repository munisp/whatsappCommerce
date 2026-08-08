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
import { and, eq, lt, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { getDb } from "../db";
import { inventoryReservations, orders, products } from "../../drizzle/schema";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle mutation/query surface (db or tx). */
export type TxHandle = Pick<DbHandle, "select" | "selectDistinct" | "insert" | "update" | "execute">;

/** Reservation TTL — matches the pending-payment window pattern (900s). */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

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
    .returning({ id: inventoryReservations.id });
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
    released++;
  }
  return released;
}

/**
 * Expiry sweeper: release every 'reserved' row past its TTL whose order is
 * NOT paid. Idempotent by construction (releaseReservations is claim-first);
 * safe to run every 60s from the scheduled-job endpoint. Returns the number
 * of reservations released.
 */
export async function releaseExpiredReservations(
  db: TxHandle,
  now: Date = new Date(),
): Promise<{ orders: number; released: number }> {
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
  for (const { orderId } of expired) {
    // Never release stock for a paid order — if the payment landed, the
    // reservation must be committed, not returned to the pool.
    const [order] = await db
      .select({ paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (order && order.paymentStatus === "completed") continue;
    const n = await releaseReservations(db, orderId, now);
    if (n > 0) {
      sweptOrders++;
      released += n;
    }
  }
  return { orders: sweptOrders, released };
}
