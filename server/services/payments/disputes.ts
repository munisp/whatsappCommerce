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
} from "../../../drizzle/schema";

type Db = any;

export type DisputeKind = "chargeback" | "dispute";
export type DisputeStatus = "open" | "won" | "lost" | "accepted";

/**
 * Map a Paystack dispute event to our status. Paystack resolves a dispute
 * with `resolution` = "merchant-accepted" (the merchant conceded — the
 * customer is refunded) or "declined" (the customer's claim was rejected —
 * the merchant keeps the money). Anything unrecognised stays "open" so a
 * human looks at it; it is never reported to the merchant as lost.
 */
export function paystackDisputeStatus(event: string, resolution: unknown): DisputeStatus {
  if (event !== "charge.dispute.resolve") return "open";
  const r = String(resolution ?? "").toLowerCase();
  if (r === "declined" || r.includes("won")) return "won";
  if (r.includes("accepted")) return "accepted";
  if (r.includes("lost")) return "lost";
  return "open";
}

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
    // === W54 disputes (DISP-8): settings.adminPhone first, then the tenant
    // OWNER membership's users.phone before giving up (shared resolver). ===
    const { resolveAdminAlertPhone } = await import("../disputeNotify");
    const adminPhone = await resolveAdminAlertPhone(db, tenantId);
    if (!adminPhone) {
      console.warn(`[pay8-alert] tenant ${tenantId} has no settings.adminPhone and no owner membership phone — alert recorded in logs only`);
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
    // === W54 disputes (DISP-2): chargeback–escrow interlock ===============
    await interlockEscrowForPspDispute(db, { tenantId, orderId, status, kind: opts.kind, disputeId, reference });
    // === END W54 disputes ===
    // === W46 privacy-consent (TEN-17): cross-tenant routing ==============
    // If the disputed order is an inter-tenant (wholesale/PO) order, route
    // the dispute to the counterparty: the SELLER tenant is the explicit
    // respondent and the buyer tenant's admin is alerted too.
    await routeCrossTenantDispute(db, disputeId);
    // === END W46 privacy-consent ===
  }
  return { ok: true, action, disputeId, tenantId, orderId };
}

// === W54 disputes (DISP-2): chargeback–escrow interlock ===================
/**
 * Two legs, both fail-open (never throws into the webhook handler):
 *
 *  1. OPEN leg — freeze the order's escrow so the disputed money cannot be
 *     settled/paid out while the PSP dispute is being fought. Reuses the
 *     SAME atomic guard as the dispute-raise path (services/disputes.ts
 *     DISPUTABLE_ESCROW_STATES): a single guarded UPDATE transitions only
 *     payment_received|escrow_held|delivery_confirmed → dispute_raised.
 *     Exactly-once + idempotent on webhook redelivery: a second delivery
 *     finds the escrow already in dispute_raised (or terminal) and the
 *     guarded UPDATE matches 0 rows. No escrow_disputes row is created —
 *     the PSP dispute is a payment-rail event, tracked on payment_disputes;
 *     the escrow state is the payout block.
 *
 *  2. LOST leg — when the PSP reports the dispute lost/accepted, the PSP has
 *     ALREADY debited the platform/merchant balance externally (debit-on-lost
 *     semantics). We record a merchant_clawbacks recovery entry (pending) so
 *     ops recovers the externally-lost funds from the merchant through the
 *     EXISTING W38 recovery rail, and raise a distinct admin alert. We NEVER
 *     move money speculatively here: no wallet debit, no escrow mutation —
 *     the clawback row is the honest record + recovery trigger. Idempotent
 *     via merchant_clawbacks_refund_uniq on refundId = `psp-dispute:<id>`
 *     (ON CONFLICT DO NOTHING — a redelivered lost event is a no-op).
 */
export async function interlockEscrowForPspDispute(
  db: Db,
  args: { tenantId: string; orderId: string; status: DisputeStatus; kind: DisputeKind; disputeId: string; reference: string },
): Promise<void> {
  const { tenantId, orderId, status } = args;
  try {
    if (status === "open") {
      const { escrowTransactions } = await import("../../../drizzle/schema");
      const { DISPUTABLE_ESCROW_STATES } = await import("../disputes");
      const { inArray } = await import("drizzle-orm");
      const frozen = await db.update(escrowTransactions).set({
        state: "dispute_raised",
        updatedAt: new Date(),
      }).where(and(
        eq(escrowTransactions.orderId, orderId),
        eq(escrowTransactions.tenantId, tenantId),
        inArray(escrowTransactions.state, [...DISPUTABLE_ESCROW_STATES] as any),
      )).returning({ id: escrowTransactions.id });
      if (frozen.length > 0) {
        console.info(`[psp-dispute] DISP-2 escrow interlock: froze ${frozen.length} escrow(s) on order ${orderId} (payout blocked while ${args.kind} is open)`);
        await sendAdminOpsAlert(
          db,
          tenantId,
          `🔒 Escrow on order ${orderId} is FROZEN (dispute_raised) — payout is blocked while the ${args.kind} (${args.reference}) is open.`,
          "payment_dispute_escrow_frozen",
          orderId,
        );
      }
      return;
    }
    if (status === "lost" || status === "accepted") {
      const { merchantClawbacks, paymentDisputes } = await import("../../../drizzle/schema");
      const [dispute] = await db.select().from(paymentDisputes)
        .where(eq(paymentDisputes.id, args.disputeId)).limit(1).catch(() => [] as any[]);
      const amountCents = dispute?.amountCents ?? null;
      if (amountCents == null || amountCents <= 0) {
        console.warn(`[psp-dispute] DISP-2 lost ${args.kind} ${args.disputeId} has no amount — recovery entry skipped, alert still sent`);
      } else {
        // refund_id is varchar(36): `cb:` + dashless uuid = 35 chars. The
        // full dispute id travels in metadata.disputeId.
        await db.insert(merchantClawbacks).values({
          tenantId,
          orderId,
          refundId: `cb:${String(args.disputeId).replace(/-/g, "")}`.slice(0, 36),
          escrowId: null,
          amountCents,
          currency: dispute?.currency ?? "NGN",
          reason: `PSP ${args.kind} ${status} (${args.reference}) — external debit already applied by the provider; recover from merchant per W38 clawback rail.`,
          status: "pending",
          metadata: { source: "psp_dispute_lost", disputeId: args.disputeId, kind: args.kind, providerRef: args.reference },
          createdAt: new Date(),
          updatedAt: new Date(),
        }).onConflictDoNothing();
      }
      await sendAdminOpsAlert(
        db,
        tenantId,
        `🧾 *Chargeback ${status}* on order ${orderId} (${args.reference})` +
        (amountCents != null ? ` — a recovery entry of ${(amountCents / 100).toFixed(2)} ${dispute?.currency ?? "NGN"} was recorded for ops follow-up.` : `.`),
        "payment_dispute_recovery",
        orderId,
      );
    }
  } catch (e: any) {
    console.error(`[psp-dispute] DISP-2 interlock failed for order ${orderId} (fail-open):`, e?.message);
  }
}
// === END W54 disputes ===

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
