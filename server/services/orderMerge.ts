/**
 * === W46 orders-p2 (Coder G, ORD-23) ===
 * orderMerge.ts — merge two PRE-SHIP orders from the same customer to the
 * same delivery address into one shipment.
 *
 * Residual-backlog ORD-23: "no merge/split in orderCrud.ts".
 *
 * MERGE contract (claim-first, one transaction):
 *   - Both orders: same tenant, same customerId, SAME normalized shipping
 *     address (see normalizeAddress), same currency, both PRE-SHIP
 *     (status pending|confirmed|processing) and UNPAID — merging paid orders
 *     would require merging escrow/payment legs, which is refused honestly
 *     (CONFLICT) instead of corrupting money.
 *   - The secondary's order_items rows are re-parented onto the primary
 *     (UPDATE ... WHERE orderId = secondary). Stock stays reserved:
 *     reservations live in inventory_snapshots keyed by productId (not
 *     orderId), so no restock/re-reserve churn is needed and oversell is
 *     impossible.
 *   - The primary's totalAmount is recomputed as the sum of ALL merged line
 *     totals + the primary's own delivery fee (integer-cents arithmetic via
 *     escrowAmounts); orders.items jsonb is re-rendered from the merged
 *     order_items rows so receipt displays stay consistent.
 *   - The secondary is flipped to 'cancelled' with a GUARDED UPDATE
 *     (status pre-ship predicate) — a concurrent ship/cancel loses the race
 *     and the merge aborts. metadata.mergedInto records the primary id;
 *     an audit_logs row (action 'order.merged') makes the merge provable.
 *   - The buyer gets a merge notice on BOTH channels via sendCustomerText
 *     (channelParity category 'order_merge').
 *
 * SPLIT contract (documented — no new code, W43 owns it):
 *   Splitting a merged (or any multi-line) order into separate shipments is
 *   the W43 partial-fulfillment path: orderFulfill.fulfillOrderLines creates
 *   one order_fulfillments event per dispatch with its own
 *   order_fulfillment_lines quantities, flips the order to
 *   'partially_fulfilled' until every line ships, and notifies the buyer per
 *   fulfillment (channelParity 'partial_fulfillment'). A merchant splitting
 *   a merged order therefore ships line-subsets via repeated
 *   fulfillOrderLines calls — the audit trail (order_fulfillments rows) is
 *   the split record. See server/services/orderFulfill.ts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { orderItems, orders } from "../../drizzle/schema";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";

type Db = any;

/** Statuses from which an order may be merged (pre-ship). */
export const MERGEABLE_STATUSES = ["pending", "confirmed", "processing"] as const;

/** Case/space-insensitive address comparison for the merge precondition. */
export function normalizeAddress(addr: unknown): string {
  if (addr == null) return "";
  const raw = typeof addr === "string"
    ? addr
    : String((addr as any).raw ?? JSON.stringify(addr));
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when two orders are merge-compatible (same customer + address, pre-ship). */
export function canMergeOrders(a: any, b: any): { ok: boolean; reason?: string } {
  if (a.id === b.id) return { ok: false, reason: "same_order" };
  if (a.tenantId !== b.tenantId) return { ok: false, reason: "tenant_mismatch" };
  if (String(a.customerId) !== String(b.customerId)) return { ok: false, reason: "customer_mismatch" };
  if (normalizeAddress(a.shippingAddress) !== normalizeAddress(b.shippingAddress)) {
    return { ok: false, reason: "address_mismatch" };
  }
  if ((a.currency ?? "NGN") !== (b.currency ?? "NGN")) return { ok: false, reason: "currency_mismatch" };
  for (const o of [a, b]) {
    if (!MERGEABLE_STATUSES.includes(o.status)) return { ok: false, reason: `not_pre_ship:${o.status}` };
    if (o.paymentStatus !== "unpaid") return { ok: false, reason: `paid_order:${o.paymentStatus}` };
  }
  return { ok: true };
}

export interface MergeResult {
  primaryOrderId: string;
  secondaryOrderId: string;
  movedItems: number;
  mergedTotalCents: number;
  mergedTotal: string;
}

/**
 * Merge secondary → primary. Throws TRPCError CONFLICT on any precondition
 * failure or lost claim race. Exactly-once: re-merging the same pair fails
 * (the secondary is already cancelled).
 */
export async function mergeOrders(
  db: Db,
  opts: { tenantId: string; primaryOrderId: string; secondaryOrderId: string; actorId?: string },
): Promise<MergeResult> {
  const [primary, secondary] = await Promise.all([
    db.select().from(orders).where(and(eq(orders.id, opts.primaryOrderId), eq(orders.tenantId, opts.tenantId))).limit(1).then((r: any[]) => r[0]),
    db.select().from(orders).where(and(eq(orders.id, opts.secondaryOrderId), eq(orders.tenantId, opts.tenantId))).limit(1).then((r: any[]) => r[0]),
  ]);
  if (!primary || !secondary) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  const compat = canMergeOrders(primary, secondary);
  if (!compat.ok) {
    throw new TRPCError({ code: "CONFLICT", message: `Orders are not mergeable: ${compat.reason}` });
  }

  return db.transaction(async (tx: Db) => {
    // Claim-first on the SECONDARY: a guarded flip to 'cancelled' is the
    // merge claim — only one concurrent merge/ship/cancel can win it.
    const [claimed] = await tx.update(orders).set({
      status: "cancelled",
      metadata: {
        ...((secondary.metadata ?? {}) as Record<string, unknown>),
        mergedInto: primary.id,
        mergedAt: new Date().toISOString(),
        mergedBy: opts.actorId ?? "system",
      },
      updatedAt: new Date(),
    }).where(and(
      eq(orders.id, secondary.id),
      eq(orders.tenantId, opts.tenantId),
      inArray(orders.status, [...MERGEABLE_STATUSES]),
      eq(orders.paymentStatus, "unpaid"),
    )).returning({ id: orders.id });
    if (!claimed) {
      throw new TRPCError({ code: "CONFLICT", message: "Secondary order changed state concurrently — merge aborted" });
    }

    // Re-parent the secondary's lines onto the primary.
    const moved = await tx.update(orderItems).set({ orderId: primary.id })
      .where(eq(orderItems.orderId, secondary.id))
      .returning({ id: orderItems.id });

    // Recompute the primary total: sum of ALL merged line totals + the
    // primary's own delivery fee. Integer-cents arithmetic throughout.
    const lines = await tx.select().from(orderItems).where(eq(orderItems.orderId, primary.id));
    const linesCents = lines.reduce(
      (s: number, l: any) => s + toMinorUnitsExact(Number(l.unitPrice) * l.quantity),
      0,
    );
    const primaryMeta = (primary.metadata ?? {}) as Record<string, unknown>;
    const deliveryFeeCents = primaryMeta.deliveryFee != null ? toMinorUnitsExact(Number(primaryMeta.deliveryFee)) : 0;
    const mergedTotalCents = linesCents + deliveryFeeCents;
    const mergedTotal = minorUnitsToString(mergedTotalCents);
    const mergedItemsJson = lines.map((l: any) => ({
      productId: l.productId, name: l.productName, qty: l.quantity, price: l.unitPrice,
    }));
    await tx.update(orders).set({
      totalAmount: mergedTotal,
      items: mergedItemsJson,
      metadata: {
        ...primaryMeta,
        mergedFrom: [...((primaryMeta.mergedFrom as string[]) ?? []), secondary.id],
        subtotal: minorUnitsToString(linesCents),
      },
      updatedAt: new Date(),
    }).where(eq(orders.id, primary.id));

    return {
      primaryOrderId: primary.id,
      secondaryOrderId: secondary.id,
      movedItems: moved.length,
      mergedTotalCents,
      mergedTotal,
    };
  }).then(async (result: MergeResult) => {
    // Post-commit: audit + buyer notice are best-effort (never roll back the
    // merge). The audit row makes the merge provable.
    try {
      const { writeAuditLog } = await import("../routers/audit");
      await writeAuditLog({
        tenantId: opts.tenantId,
        actorId: opts.actorId ?? "system",
        actorRole: "merchant",
        action: "order.merged",
        entityType: "order",
        entityId: primary.id,
        summary: `Merged order ${secondary.orderNumber} into ${primary.orderNumber} (${result.movedItems} items, new total ${result.mergedTotal} ${primary.currency})`,
      });
    } catch (e: any) {
      console.warn("[orderMerge] audit write failed:", e?.message);
    }
    try {
      const { sendCustomerText } = await import("./channelParity");
      await sendCustomerText(
        opts.tenantId,
        String(primary.customerId),
        "order_merge",
        `📦 Your orders ${secondary.orderNumber} and ${primary.orderNumber} were combined into one delivery (order ${primary.orderNumber}). Same items, one shipment — nothing else changed.`,
        { notifType: "order_update" },
      );
    } catch (e: any) {
      console.warn("[orderMerge] buyer notice failed:", e?.message);
    }
    return result;
  });
}
// === END W46 orders-p2 ===
