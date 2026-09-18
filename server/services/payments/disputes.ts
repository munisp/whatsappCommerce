/**
 * W39 PAY-8 — PSP chargeback/dispute + refund-status webhook reconciliation.
 *
 * Before W39 the paystack/flutterwave webhook handlers branched only on
 * successful charge / transfer events and bare-200'd everything else, so
 * chargebacks and refund-status events were silently dropped while the PSP
 * debited the platform balance out-of-band.
 *
 * This module is the adjacent seam (paymentConfirm.ts stays PINNED):
 *   - recordPspDispute   — upsert a payment_disputes row (idempotent on
 *                          provider+provider_ref+kind for webhook redelivery),
 *                          flag the order, alert the tenant admin on WhatsApp.
 *   - reconcilePspRefund — refund.processed confirms the matching W38
 *                          refund_attempts row; refund.failed marks it failed
 *                          and raises the same admin alert.
 *
 * Debit-on-lost semantics: recording a dispute here never moves money. When
 * a dispute is lost/accepted the PSP has ALREADY debited the merchant of
 * record externally; the status is the honest record of that external debit
 * and the trigger for ops recovery (merchant_clawbacks, W38). Dispute
 * evidence submission still happens on the PSP dashboard — out of scope.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  orders,
  paymentDisputes,
  paymentIntents,
  paymentTransactions,
  refundAttempts,
  tenants,
} from "../../../drizzle/schema";

type Db = any;

export type DisputeKind = "chargeback" | "dispute";
export type DisputeStatus = "open" | "won" | "lost" | "accepted";

/** Resolve a PSP payment reference to (tenantId, orderId) via either table. */
async function resolveReference(
  db: Db,
  reference: string,
): Promise<{ tenantId: string; orderId: string | null } | null> {
  const [tx] = await db.select({
    tenantId: paymentTransactions.tenantId,
    orderId: paymentTransactions.orderId,
  }).from(paymentTransactions)
    .where(eq(paymentTransactions.providerRef, reference)).limit(1);
  if (tx) return { tenantId: tx.tenantId, orderId: tx.orderId ?? null };
  const [intent] = await db.select({
    tenantId: paymentIntents.tenantId,
    orderId: paymentIntents.orderId,
  }).from(paymentIntents)
    .where(eq(paymentIntents.providerPaymentId, reference)).limit(1);
  if (intent) return { tenantId: intent.tenantId, orderId: intent.orderId ?? null };
  return null;
}

/** Admin WhatsApp ops alert via the existing waSender path (never throws). */
export async function sendAdminOpsAlert(
  db: Db,
  tenantId: string,
  body: string,
  notifType: string,
  orderId?: string | null,
): Promise<void> {
  try {
    const [tenant] = await db.select({ settings: tenants.settings })
      .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
    const adminPhone = typeof settings.adminPhone === "string" ? settings.adminPhone : "";
    if (!adminPhone) {
      console.warn(`[pay8-alert] tenant ${tenantId} has no settings.adminPhone — alert recorded in logs only`);
      return;
    }
    const { sendWhatsAppText } = await import("../waSender");
    await sendWhatsAppText(tenantId, adminPhone, body, { notifType, orderId: orderId ?? null });
  } catch (e: any) {
    console.error(`[pay8-alert] ${notifType} alert failed for tenant ${tenantId}:`, e?.message);
  }
}

/** Flag the order (metadata.dispute) without touching the PINNED confirm path. */
async function flagOrderDispute(
  db: Db,
  tenantId: string,
  orderId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const [row] = await db.select({ metadata: orders.metadata })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!row) return;
    const metadata = { ...((row.metadata as Record<string, unknown>) ?? {}), dispute: patch };
    await db.update(orders).set({ metadata, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)));
  } catch (e: any) {
    console.error(`[psp-dispute] order flag failed for ${orderId}:`, e?.message);
  }
}

export interface RecordDisputeOpts {
  provider: "paystack" | "flutterwave" | string;
  /** PSP payment reference the dispute/chargeback relates to. */
  providerRef: string;
  kind: DisputeKind;
  status?: DisputeStatus;
  amountCents?: number | null;
  currency?: string | null;
  payload?: unknown;
}

export interface RecordDisputeResult {
  ok: boolean;
  action: "recorded" | "updated" | "unresolved-reference" | "no-reference";
  disputeId?: string;
  tenantId?: string;
  orderId?: string | null;
}

/**
 * Persist a chargeback/dispute event. Idempotent across PSP redelivery via
 * the (provider, provider_ref, kind) unique index — a redelivery or a
 * follow-up status event updates status/payload instead of duplicating.
 */
export async function recordPspDispute(db: Db, opts: RecordDisputeOpts): Promise<RecordDisputeResult> {
  const reference = String(opts.providerRef ?? "").trim();
  if (!reference) return { ok: false, action: "no-reference" };
  const status: DisputeStatus = opts.status ?? "open";
  const resolved = await resolveReference(db, reference);
  if (!resolved) {
    console.warn(`[psp-dispute] ${opts.provider} ref=${reference} matched no payment row — recorded under tenant 'unresolved'`);
  }
  const tenantId = resolved?.tenantId ?? "unresolved";
  const orderId = resolved?.orderId ?? null;
  const now = new Date();

  const [existing] = await db.select().from(paymentDisputes)
    .where(and(
      eq(paymentDisputes.provider, String(opts.provider)),
      eq(paymentDisputes.providerRef, reference),
      eq(paymentDisputes.kind, opts.kind),
    )).limit(1);

  let disputeId: string;
  let action: "recorded" | "updated";
  if (existing) {
    disputeId = existing.id;
    action = "updated";
    await db.update(paymentDisputes)
      .set({
        status,
        amountCents: opts.amountCents ?? existing.amountCents,
        payload: (opts.payload ?? existing.payload) as any,
        updatedAt: now,
      })
      .where(eq(paymentDisputes.id, existing.id));
  } else {
    const [inserted] = await db.insert(paymentDisputes).values({
      tenantId,
      orderId,
      provider: String(opts.provider),
      providerRef: reference,
      kind: opts.kind,
      amountCents: opts.amountCents ?? null,
      currency: opts.currency ?? "NGN",
      status,
      payload: (opts.payload ?? null) as any,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: paymentDisputes.id });
    disputeId = inserted.id;
    action = "recorded";
  }

  if (orderId && tenantId !== "unresolved") {
    await flagOrderDispute(db, tenantId, orderId, {
      status,
      kind: opts.kind,
      provider: opts.provider,
      providerRef: reference,
      disputeId,
      at: now.toISOString(),
    });
    await sendAdminOpsAlert(
      db,
      tenantId,
      `🚨 *Payment ${opts.kind}* (${status}): ${opts.provider} ref ${reference}` +
      (opts.amountCents != null ? ` for ${(opts.amountCents / 100).toFixed(2)} ${opts.currency ?? "NGN"}` : "") +
      ` on order ${orderId}. The order is flagged; review the dispute in your PSP dashboard.`,
      "payment_dispute_alert",
      orderId,
    );
    // === W46 privacy-consent (TEN-17): cross-tenant routing ==============
    // If the disputed order is an inter-tenant (wholesale/PO) order, route
    // the dispute to the counterparty: the SELLER tenant is the explicit
    // respondent and the buyer tenant's admin is alerted too.
    await routeCrossTenantDispute(db, disputeId);
    // === END W46 privacy-consent ===
  }
  return { ok: true, action, disputeId, tenantId, orderId };
}

// === W46 privacy-consent (TEN-17): cross-tenant dispute routing ===========
/**
 * Minimal, honest cross-tenant routing: when a dispute's order is an
 * inter-tenant wholesale order (wholesale_orders.buyer_tenant_id set and
 * different from the payee tenant), stamp respondentTenantId with the seller
 * (payee) tenant — the party that must respond — and notify the BUYER
 * tenant's admin that the dispute was routed. Single-tenant retail disputes
 * keep respondentTenantId NULL and are untouched. Never throws.
 */
export async function routeCrossTenantDispute(db: Db, disputeId: string): Promise<{ routed: boolean; buyerTenantId?: string }> {
  try {
    const [dispute] = await db.select().from(paymentDisputes)
      .where(eq(paymentDisputes.id, disputeId)).limit(1);
    if (!dispute?.orderId) return { routed: false };
    const { wholesaleOrders } = await import("../../../drizzle/schema");
    const [wso] = await db.select({
      buyerTenantId: wholesaleOrders.buyerTenantId,
      tenantId: wholesaleOrders.tenantId,
    }).from(wholesaleOrders)
      .where(eq(wholesaleOrders.orderId, dispute.orderId)).limit(1)
      .catch(() => []);
    const buyerTenantId = wso?.buyerTenantId ?? null;
    if (!buyerTenantId || buyerTenantId === dispute.tenantId) return { routed: false };
    await db.update(paymentDisputes)
      .set({ respondentTenantId: dispute.tenantId, updatedAt: new Date() })
      .where(eq(paymentDisputes.id, disputeId));
    await sendAdminOpsAlert(
      db,
      buyerTenantId,
      `🚨 A payment ${dispute.kind} on your wholesale order ${dispute.orderId} was routed to the supplier for response (dispute ${disputeId}).`,
      "payment_dispute_routed",
      dispute.orderId,
    );
    console.info(`[psp-dispute] TEN-17 cross-tenant routing: dispute=${disputeId} buyer=${buyerTenantId} respondent=${dispute.tenantId}`);
    return { routed: true, buyerTenantId };
  } catch (e: any) {
    console.error(`[psp-dispute] TEN-17 routing failed for ${disputeId}:`, e?.message);
    return { routed: false };
  }
}
// === END W46 privacy-consent ===

export interface RefundReconcileOpts {
  provider: "paystack" | "flutterwave" | string;
  /** PSP refund reference (or payment reference when the PSP omits one). */
  providerRef: string;
  outcome: "processed" | "failed";
  amountCents?: number | null;
  payload?: unknown;
}

export interface RefundReconcileResult {
  ok: boolean;
  action: "confirmed" | "marked-failed" | "no-matching-attempt" | "no-reference";
  attemptId?: string;
}

/**
 * Reconcile a refund.processed / refund.failed PSP event against the W38
 * refund_attempts ledger: processed confirms the newest non-terminal attempt
 * for the reference; failed marks it failed AND alerts the tenant admin.
 */
export async function reconcilePspRefund(db: Db, opts: RefundReconcileOpts): Promise<RefundReconcileResult> {
  const reference = String(opts.providerRef ?? "").trim();
  if (!reference) return { ok: false, action: "no-reference" };
  const now = new Date();

  // Match on the provider refund ref first, then on the payment reference a
  // naive PSP may echo back (both land in refund_attempts.provider_ref).
  const candidates = await db.select().from(refundAttempts)
    .where(and(
      eq(refundAttempts.provider, String(opts.provider)),
      eq(refundAttempts.providerRef, reference),
    ))
    .orderBy(desc(refundAttempts.createdAt))
    .limit(5);
  const attempt = candidates.find((r: any) => r.status !== "processed") ?? candidates[0];

  if (!attempt) {
    // No local attempt — the refund was initiated on the PSP dashboard. Keep
    // it visible (structured log) and alert ops; never silently drop.
    console.warn(`[psp-refund] ${opts.provider} refund.${opts.outcome} ref=${reference} matched no refund_attempts row`);
    const resolved = await resolveReference(db, reference);
    if (resolved?.tenantId) {
      await sendAdminOpsAlert(
        db,
        resolved.tenantId,
        `⚠️ *Provider refund ${opts.outcome}* with no matching local refund: ${opts.provider} ref ${reference}. Investigate on your PSP dashboard.`,
        "payment_refund_alert",
        resolved.orderId,
      );
    }
    return { ok: true, action: "no-matching-attempt" };
  }

  if (opts.outcome === "processed") {
    if (attempt.status !== "processed") {
      await db.update(refundAttempts).set({ status: "processed" })
        .where(eq(refundAttempts.id, attempt.id));
    }
    return { ok: true, action: "confirmed", attemptId: attempt.id };
  }

  await db.update(refundAttempts).set({
    status: "failed",
    error: `provider reported refund.failed at ${now.toISOString()}`,
  }).where(eq(refundAttempts.id, attempt.id));
  await sendAdminOpsAlert(
    db,
    attempt.tenantId,
    `🚨 *Refund FAILED at provider*: ${opts.provider} ref ${reference}` +
    (attempt.amountCents != null ? ` (${(attempt.amountCents / 100).toFixed(2)} ${attempt.currency ?? "NGN"})` : "") +
    (attempt.orderId ? ` for order ${attempt.orderId}` : "") +
    `. The customer has NOT been refunded — retry the refund or reconcile manually.`,
    "payment_refund_alert",
    attempt.orderId,
  );
  return { ok: true, action: "marked-failed", attemptId: attempt.id };
}

/** Structured log for webhook events we ack but do not handle (no silent drop). */
export function logUnhandledPspEvent(provider: string, payload: any): void {
  console.info(JSON.stringify({
    tag: "psp-webhook-unhandled",
    provider,
    event: typeof payload?.event === "string" ? payload.event : null,
    reference: payload?.data?.reference ?? payload?.data?.tx_ref ?? null,
    at: new Date().toISOString(),
  }));
}
