// === W44 preorders-offers ===
/**
 * preorders.ts — pre-orders (mig 0138).
 *
 * Flow:
 *   1. A product with preorderEnabled=TRUE and preorderAvailableAt in the
 *      FUTURE may be checked out before availability. The orderCrud create
 *      seam calls markPreorderLinesTx inside the order transaction: matching
 *      lines are stamped status='preorder' and the order metadata gains a
 *      `preorder` snapshot { availableAt, depositPct, depositCents,
 *      totalCents } (integer cents; depositPct from
 *      tenants.preorderDepositPct, 0-100, default 100 = full capture).
 *   2. Availability: the lazy sweeper sweepDuePreorders (existing CronJob
 *      pattern — POST /api/scheduled/preorders-due) claims due lines with a
 *      guarded UPDATE ... status='preorder' → 'ordered' RETURNING, so
 *      concurrent sweeps can't double-flip. Flipped lines enter the NORMAL
 *      W43 fulfillment path (fulfillOrderLines) unchanged; the customer is
 *      notified on BOTH channels via channelParity category
 *      'preorder_status'.
 *   3. Cancel before availability (cancelPreorder): every preorder line
 *      must still be 'preorder' and now < availableAt; then the EXISTING
 *      cancel path (orderCancel.cancelOrder — stock+status, claim-first) runs
 *      and any paid escrow is refunded IN FULL via refundEscrowAtomic +
 *      executeProviderRefund — never partially, never faked: a provider
 *      failure flags the escrow for the refund sweep.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  escrowTransactions,
  orderItems,
  orders,
  products,
  tenants,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const PREORDER_CATEGORY = "preorder_status";
/** Line status vocabulary extension (order_items.status is varchar(16)). */
export const PREORDER_LINE_STATUS = "preorder";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function normalizeDepositPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) return 100;
  return n;
}

export async function tenantPreorderDepositPct(db: Db, tenantId: string): Promise<number> {
  const [t] = await db
    .select({ pct: tenants.preorderDepositPct })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return normalizeDepositPct(t?.pct ?? 100);
}

/** Integer-cents deposit for a pre-order total (round half up). */
export function preorderDepositCents(totalCents: number, depositPct: number): number {
  return Math.round((totalCents * normalizeDepositPct(depositPct)) / 100);
}

/**
 * Checkout seam (orderCrud create, inside the order transaction): mark lines
 * whose product is preorderEnabled with a FUTURE preorderAvailableAt as
 * 'preorder', and snapshot the preorder terms (availableAt, depositPct,
 * integer-cents totals) into orders.metadata.preorder. Returns the marked
 * line ids (empty when nothing is a pre-order — metadata untouched).
 */
export async function markPreorderLinesTx(
  tx: any,
  tenantId: string,
  orderId: string,
  lines: { productId: string; qty: number; orderLineId: string; unitPriceCents: number }[],
): Promise<string[]> {
  const productIds = Array.from(new Set(lines.map((l) => l.productId)));
  if (!productIds.length) return [];
  const rows = await tx
    .select({
      id: products.id,
      preorderEnabled: products.preorderEnabled,
      preorderAvailableAt: products.preorderAvailableAt,
    })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)));
  const now = new Date();
  const preById = new Map<string, Date>(
    rows
      .filter((p: any) => p.preorderEnabled && p.preorderAvailableAt && new Date(p.preorderAvailableAt) > now)
      .map((p: any): [string, Date] => [p.id, new Date(p.preorderAvailableAt)]),
  );
  const marked: string[] = [];
  let totalCents = 0;
  let availableAt: Date | null = null;
  for (const l of lines) {
    const at = preById.get(l.productId);
    if (!at) continue;
    await tx
      .update(orderItems)
      .set({ status: PREORDER_LINE_STATUS })
      .where(and(eq(orderItems.id, l.orderLineId), eq(orderItems.orderId, orderId)));
    marked.push(l.orderLineId);
    totalCents += l.unitPriceCents * l.qty;
    if (!availableAt || at > availableAt) availableAt = at;
  }
  if (!marked.length) return [];
  const depositPct = await tenantPreorderDepositPct(tx as Db, tenantId);
  const [ord] = await tx.select({ metadata: orders.metadata }).from(orders).where(eq(orders.id, orderId)).limit(1);
  const meta = { ...(((ord?.metadata ?? {}) as Record<string, unknown>) ?? {}) };
  meta.preorder = {
    availableAt: availableAt!.toISOString(),
    depositPct,
    totalCents,
    depositCents: preorderDepositCents(totalCents, depositPct),
    lineIds: marked,
  };
  await tx.update(orders).set({ metadata: meta, updatedAt: new Date() }).where(eq(orders.id, orderId));
  return marked;
}

// ─── Availability sweeper (lazy flip, existing CronJob pattern) ─────────────

export interface PreorderSweepResult {
  ordersFlipped: number;
  linesFlipped: number;
  notified: number;
}

/**
 * Flip due preorder lines → 'ordered' (claim-first guarded UPDATE, so
 * concurrent sweeps serialize and a replayed sweep flips nothing), then
 * notify each affected customer on BOTH channels. Fulfillment is the normal
 * W43 path from here — preorder lines are indistinguishable after the flip.
 */
export async function sweepDuePreorders(
  opts: { now?: Date; db?: Db; notify?: (tenantId: string, ref: string, category: string, text: string) => Promise<unknown> } = {},
): Promise<PreorderSweepResult> {
  const db = opts.db ?? (await getDb());
  if (!db) return { ordersFlipped: 0, linesFlipped: 0, notified: 0 };
  const now = opts.now ?? new Date();
  const claimed = (await db.execute(sql`
    UPDATE "order_items" oi
    SET "status" = 'ordered'
    FROM "products" p
    WHERE oi."productId" = p."id"
      AND oi."status" = 'preorder'
      AND p."preorderEnabled" = true
      AND p."preorderAvailableAt" IS NOT NULL
      AND p."preorderAvailableAt" <= ${now.toISOString()}
    RETURNING oi."id", oi."orderId"
  `)) as unknown as any[];
  const lines = (Array.isArray(claimed) ? claimed : (claimed as any).rows ?? []) as any[];
  if (!lines.length) return { ordersFlipped: 0, linesFlipped: 0, notified: 0 };

  const orderIds = Array.from(new Set(lines.map((l) => l.orderId ?? l.orderid)));
  let notified = 0;
  for (const orderId of orderIds) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1).catch(() => [] as any[]);
    if (!order) continue;
    const text =
      `🎉 Good news — your pre-order ${order.orderNumber} is now available and has entered fulfillment. ` +
      `We'll message you here as it ships.`;
    const notify = opts.notify ?? (async (tenantId: string, ref: string, category: string, body: string) => {
      const { sendCustomerText } = await import("./channelParity");
      return sendCustomerText(tenantId, ref, category, body, { notifType: PREORDER_CATEGORY, orderId: order.id });
    });
    await notify(order.tenantId, order.customerId, PREORDER_CATEGORY, text)
      .then(() => { notified++; })
      .catch((e: unknown) => console.warn("[preorders] availability notify failed:", (e as Error)?.message));
  }
  return { ordersFlipped: orderIds.length, linesFlipped: lines.length, notified };
}

// ─── Cancel before availability = full refund ────────────────────────────────

/**
 * Cancel a pre-order before availability: ALL preorder lines must still be
 * 'preorder' and now < availableAt (once flipped, the normal cancel rules of
 * orderCrud.apply). Stock+status via the existing cancelOrder path; any
 * active escrow is refunded IN FULL via refundEscrowAtomic + the provider
 * refund leg (best-effort, honest status — a provider failure flags the
 * escrow for the refund sweep, it can never be silently released).
 */
export async function cancelPreorder(
  db: Db,
  opts: { tenantId: string; orderId: string; reason?: string; decidedBy?: string | null },
): Promise<{ orderId: string; refunded: boolean; refundCents: number }> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
  const { assertTenantActive } = await import("./tenantGuard");
  assertTenantActive(tenant);

  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId)))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const preLines = lines.filter((l) => l.status === PREORDER_LINE_STATUS);
  if (!preLines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Order has no pre-order lines — use the normal cancel path" });
  }
  const preMeta = ((order.metadata ?? {}) as any).preorder ?? null;
  const availableAtMeta = preMeta?.availableAt ? new Date(preMeta.availableAt) : null;
  // Effective availability: the metadata snapshot AND the product's current
  // preorderAvailableAt (the merchant may have pulled the date forward) —
  // the EARLIEST wins; once it has passed, normal cancel rules apply.
  const prodIds = Array.from(new Set(preLines.map((l) => l.productId)));
  const prodRows = await db.select({ preorderAvailableAt: products.preorderAvailableAt })
    .from(products)
    .where(and(eq(products.tenantId, opts.tenantId), inArray(products.id, prodIds)))
    .catch(() => [] as any[]);
  const now = new Date();
  const availableNow =
    (availableAtMeta && availableAtMeta <= now) ||
    prodRows.some((p) => p.preorderAvailableAt && new Date(p.preorderAvailableAt) <= now);
  if (availableNow) {
    throw new TRPCError({ code: "CONFLICT", message: "Pre-order is already available — use the normal cancel path" });
  }

  const { cancelOrder } = await import("./orderCancel");
  await cancelOrder(db, order as any, { reason: opts.reason ?? "preorder_cancelled" });

  // Full refund of any captured money (deposit or full capture alike).
  let refunded = false;
  let refundCents = 0;
  const [activeEscrow] = await db.select().from(escrowTransactions)
    .where(and(
      eq(escrowTransactions.orderId, order.id),
      inArray(escrowTransactions.state, ["payment_received", "escrow_held", "delivery_confirmed", "dispute_raised"]),
    ))
    .limit(1);
  if (activeEscrow) {
    const { refundEscrowAtomic } = await import("../routers/escrow");
    const refund = await refundEscrowAtomic(db, activeEscrow.id, {
      reason: `Pre-order ${order.orderNumber} cancelled before availability: full refund`,
    }).catch((e: unknown) => ({ success: false as const, error: (e as Error)?.message ?? String(e) }));
    if (refund.success) {
      refunded = true;
      refundCents = Math.round(refund.refundedAmount * 100);
      const { executeProviderRefund, honestOrderRefundStatus } = await import("./payments/refunds");
      const outcome = await executeProviderRefund(db, {
        tenantId: opts.tenantId,
        orderId: order.id,
        amountCents: refundCents,
        currency: order.currency ?? "NGN",
        reason: `Pre-order ${order.orderNumber} cancelled before availability`,
      });
      await db.update(orders).set({ paymentStatus: honestOrderRefundStatus(outcome), updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      if (outcome.status === "failed") {
        const meta = (activeEscrow.metadata ?? {}) as Record<string, unknown>;
        await db.update(escrowTransactions).set({
          metadata: { ...meta, refundSweepRequired: true, providerRefundOnly: true, providerRefundFailed: true, providerRefundError: outcome.error ?? "unknown" },
          updatedAt: new Date(),
        }).where(eq(escrowTransactions.id, activeEscrow.id));
      }
    } else {
      // Fail-closed: flag for the SLA refund sweep — never leave it releasable.
      const meta = (activeEscrow.metadata ?? {}) as Record<string, unknown>;
      await db.update(escrowTransactions).set({
        metadata: { ...meta, refundSweepRequired: true, refundSweepReason: `preorder cancel-refund failed: ${"error" in refund ? refund.error : "unknown"}` },
        updatedAt: new Date(),
      }).where(eq(escrowTransactions.id, activeEscrow.id));
    }
  }

  // Customer notified on BOTH channels.
  try {
    const { sendCustomerText } = await import("./channelParity");
    const fmt = refundCents > 0 ? ` Your ₦${(refundCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} has been refunded in full.` : "";
    await sendCustomerText(opts.tenantId, order.customerId, PREORDER_CATEGORY,
      `🛑 Your pre-order ${order.orderNumber} was cancelled before availability.${fmt}`,
      { notifType: PREORDER_CATEGORY, orderId: order.id });
  } catch (e: any) {
    console.warn("[preorders] cancel notify failed:", e?.message);
  }

  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: opts.tenantId,
      actorId: opts.decidedBy ?? order.customerId,
      action: "preorder.cancelled",
      entityType: "order",
      entityId: order.id,
      summary: `order=${order.orderNumber} refunded=${refunded} refundCents=${refundCents}`,
    } as any);
  } catch (e: any) {
    console.warn("[preorders] audit write failed:", e?.message);
  }

  return { orderId: order.id, refunded, refundCents };
}
