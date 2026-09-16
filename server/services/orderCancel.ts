/**
 * ORD-4: single order-cancellation path used by BOTH orderCrud.updateStatus
 * (status → cancelled) and orderCrud.cancel. Before W38 the two paths
 * diverged: updateStatus only flipped the status + released pre-payment
 * reservations (no inventory_snapshots restock, no committed-reservation
 * restock), while cancel restocked snapshots but never restored
 * products.stockQuantity for PAID orders (ORD-1 — paymentConfirm commits the
 * reservations, so 'reserved'-only release found nothing and the two stock
 * ledgers diverged).
 *
 * cancelOrder performs, consistently for every cancel:
 *   1. inventory_snapshots restock (reservedQty↓ / availableQty↑) for every
 *      order item — tenantId-predicated (ORD-2 hygiene) — plus the guarded
 *      status flip, in ONE transaction. The status guard in the UPDATE makes
 *      a concurrent cancel/fulfil a CONFLICT instead of a double restock.
 *   2. releaseReservations — pre-payment 'reserved' rows back to the pool.
 *   3. releaseCommittedReservations — PAID orders: 'committed' rows back to
 *      the pool (ORD-1). Both release fns are claim-first, so running both,
 *      or running cancelOrder twice, restocks exactly once.
 *
 * Money-side effects (escrow refund, provider refund, refund-sweep flags)
 * stay in the caller — this fn is the stock + status leg only.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { orderItems, orders } from "../../drizzle/schema";
import {
  releaseCommittedReservations,
  releaseReservations,
  type TxHandle,
} from "./inventory";

type OrderStatus = "pending" | "confirmed" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded";

interface DbLike extends TxHandle {
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

export async function cancelOrder(
  db: DbLike,
  order: { id: string; tenantId: string; status: OrderStatus },
  opts: { reason?: string; notes?: string } = {},
): Promise<void> {
  // Terminal-state guard: cancelling an already-cancelled/refunded order is
  // rejected (not silently re-restoked) — exactly-once for the snapshot leg.
  if (order.status === "cancelled" || order.status === "refunded") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Order already ${order.status}` });
  }
  const now = new Date();
  const noteText =
    opts.notes ?? (opts.reason ? `Cancelled: ${opts.reason}` : "Cancelled");

  // Snapshot restock + status flip in ONE transaction: a mid-flight failure
  // can no longer leave stock released for an order that is still active
  // (or vice versa).
  await db.transaction(async (tx) => {
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    for (const item of items) {
      // ORD-2 hygiene: tenantId predicate on the snapshot credit.
      await tx.execute(sql`
        UPDATE inventory_snapshots
        SET "reservedQty" = GREATEST(0, CAST("reservedQty" AS NUMERIC) - ${item.quantity}),
            "availableQty" = CAST("availableQty" AS NUMERIC) + ${item.quantity}
        WHERE "productId" = ${item.productId} AND "tenantId" = ${order.tenantId}
      `);
    }

    const transitioned = await tx.update(orders).set({
      status: "cancelled",
      notes: noteText,
      updatedAt: now,
    }).where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
      .returning({ id: orders.id });
    if (transitioned.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Order status changed concurrently — cancel aborted, no stock was released",
      });
    }
  });

  // Pre-payment reservations (0031) — claim-first and idempotent, so a
  // concurrent expiry-sweeper run can't double-restock.
  await releaseReservations(db, order.id, now)
    .catch((e: unknown) => console.error("[orderCancel] reservation release error:", (e as Error)?.message));

  // ORD-1: paid orders hold COMMITTED reservations (paymentConfirm flipped
  // them) — restock those too, exactly once.
  await releaseCommittedReservations(db, order.id, now)
    .catch((e: unknown) => console.error("[orderCancel] committed-reservation release error:", (e as Error)?.message));
}
