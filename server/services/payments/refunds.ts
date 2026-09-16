/**
 * Provider refund execution (W30 Coder B — verify-v1 finding #9).
 *
 * Before W30, "refunds" were bookkeeping-only: rows were inserted and
 * approved, but no provider refund API was ever called — money never moved
 * back to the buyer. This module executes a REAL provider refund for
 * PSP-custody payments (via the adapter's optional `refund` capability) and
 * reports honest statuses:
 *
 *   - provider executed/queued  → refundReference + status from the provider
 *   - no provider refund path    → executed:false, reason "no_provider_refund"
 *     (callers MUST use honest "refund_recorded" vocabulary, never claim the
 *     money was "returned to buyer")
 *
 * The original payment reference is resolved server-side from the order's
 * completed payment intent / transaction — never from the client.
 */
import { createHash } from "node:crypto";
import { eq, and, desc, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { paymentIntents, paymentTransactions, refundAttempts } from "../../../drizzle/schema";
import { getProviderForTenant } from "./providers/registry";
import type { RefundResult, VerifyRefundResult } from "./providers/types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ProviderRefundOutcome {
  /** True when a provider refund API was actually invoked and accepted. */
  executed: boolean;
  status: "processed" | "pending" | "failed" | "no_provider_refund";
  provider?: string;
  refundReference?: string;
  error?: string;
  /** W38 (PAY-2): attempt ended ambiguously (timeout) — verify before retry. */
  ambiguous?: boolean;
  /** W38 (PAY-2): deterministic idempotency key used for the attempt. */
  idempotencyKey?: string;
}

/**
 * W38 (PAY-2): deterministic refund idempotency key. The SAME logical refund
 * (tenant + order + refund row, or tenant + reference + amount when no
 * refund row exists) always produces the same key, so retries are
 * correlatable provider-side and in refund_attempts.
 */
export function refundIdempotencyKey(parts: {
  tenantId: string;
  orderId?: string;
  refundId?: string;
  reference?: string;
  amountCents: number;
}): string {
  const seed = parts.refundId
    ? `${parts.tenantId}|${parts.orderId ?? ""}|${parts.refundId}`
    : `${parts.tenantId}|${parts.reference ?? ""}|${Math.round(parts.amountCents)}`;
  return `ref:${createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
}

/** W38 (PAY-2): record one provider refund attempt. Best-effort, never throws. */
export async function recordRefundAttempt(
  db: Db,
  row: {
    tenantId: string;
    refundId?: string;
    orderId?: string;
    provider: string;
    providerRef?: string;
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    status: string;
    error?: string;
  },
): Promise<void> {
  try {
    await db.insert(refundAttempts).values({
      tenantId: row.tenantId,
      refundId: row.refundId ?? null,
      orderId: row.orderId ?? null,
      provider: row.provider,
      providerRef: row.providerRef ?? null,
      idempotencyKey: row.idempotencyKey,
      amountCents: Math.round(row.amountCents),
      currency: row.currency,
      status: row.status,
      error: row.error ?? null,
    });
  } catch (err) {
    console.error("[refunds] refund_attempts insert failed (non-fatal):", (err as Error)?.message);
  }
}

/**
 * W38 (PAY-2) verify-before-retry: ask the provider whether a refund already
 * exists for the original payment reference. Returns "not_found" when the
 * provider has no refund capability at all (nothing to verify against —
 * callers treat that as safe-to-retry only when NO refund-capable provider
 * exists, which already short-circuits earlier).
 */
export async function verifyProviderRefund(opts: {
  tenantId: string;
  reference: string;
  provider?: string;
}): Promise<VerifyRefundResult> {
  try {
    const chain = await getProviderForTenant(opts.tenantId);
    const verifiable = chain.filter((e) => typeof e.provider.verifyRefund === "function");
    if (verifiable.length === 0) return { state: "unknown", provider: opts.provider ?? "", error: "no verify-capable provider configured" };
    const entry = (opts.provider ? verifiable.find((e) => e.provider.id === opts.provider) : undefined) ?? verifiable[0]!;
    return await entry.provider.verifyRefund!(opts.reference, entry.creds);
  } catch (err: any) {
    return { state: "unknown", provider: opts.provider ?? "", error: String(err?.message ?? err) };
  }
}

/**
 * Resolve the original completed payment reference for an order. Payment
 * intents carry the provider reference; legacy payment_transactions carry it
 * on the row itself.
 */
async function resolveOriginalPayment(db: Db, tenantId: string, orderId: string) {
  const [intent] = await db
    .select()
    .from(paymentIntents)
    .where(and(
      eq(paymentIntents.orderId, orderId),
      eq(paymentIntents.tenantId, tenantId),
      eq(paymentIntents.status, "completed"),
    ))
    .orderBy(desc(paymentIntents.completedAt))
    .limit(1);
  if (intent) {
    const meta = (intent.metadata ?? {}) as Record<string, unknown>;
    const reference =
      (intent.providerPaymentId ?? "") ||
      (typeof meta.reference === "string" ? (meta.reference as string) : "") ||
      (typeof meta.providerReference === "string" ? (meta.providerReference as string) : "");
    return { reference, provider: String(intent.provider ?? meta.provider ?? ""), amountCents: Math.round(parseFloat(String(intent.amount)) * 100) };
  }
  const [tx] = await db
    .select()
    .from(paymentTransactions)
    .where(and(
      eq(paymentTransactions.orderId, orderId),
      eq(paymentTransactions.tenantId, tenantId),
      inArray(paymentTransactions.status, ["completed", "success"]),
    ))
    .orderBy(desc(paymentTransactions.paidAt))
    .limit(1);
  if (!tx) return null;
  return {
    reference: String(tx.providerRef ?? tx.providerTxId ?? ""),
    provider: String(tx.provider ?? ""),
    amountCents: Math.round(parseFloat(String(tx.amount)) * 100),
  };
}

/** B's honest refund vocabulary (W30 — verify-v1 #9). */
export type HonestRefundVocabulary = "refund_paid" | "refund_initiated" | "refund_recorded" | "refund_failed";

/**
 * Map a provider refund outcome to the honest vocabulary:
 *  - provider confirmed executed   → refund_paid
 *  - provider accepted (queued)    → refund_initiated (NOT yet paid)
 *  - provider attempted & failed   → refund_failed
 *  - no provider refund path        → refund_recorded (platform-internal only —
 *    the buyer's bank was NOT refunded)
 */
export function honestRefundVocabulary(outcome: ProviderRefundOutcome): HonestRefundVocabulary {
  if (outcome.executed) return outcome.status === "processed" ? "refund_paid" : "refund_initiated";
  return outcome.status === "failed" ? "refund_failed" : "refund_recorded";
}

/**
 * Honest orders.paymentStatus vocabulary for a full-refund flow
 * (verify-v1 #9 W30 hotfix): "refunded" is reserved for provider-confirmed
 * execution; a queued provider refund is "refund_initiated"; an
 * internal-ledger-only refund is "refund_recorded" — we never claim money
 * was returned to the buyer's bank when it wasn't.
 */
export function honestOrderRefundStatus(
  outcome: ProviderRefundOutcome,
): "refunded" | "refund_initiated" | "refund_recorded" {
  if (outcome.executed) return outcome.status === "processed" ? "refunded" : "refund_initiated";
  return "refund_recorded";
}

/**
 * Execute a provider refund against an EXPLICIT PSP reference — for holds
 * that have no order row (e.g. group-deal participant paymentRefs).
 * Never throws.
 */
export async function executeProviderRefundByReference(
  db: Db,
  opts: {
    tenantId: string;
    reference: string;
    provider?: string;
    amountCents: number;
    currency: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    /** W38 (PAY-2): refund row id — part of the deterministic idempotency key. */
    refundId?: string;
    orderId?: string;
  },
): Promise<ProviderRefundOutcome> {
  try {
    if (!opts.reference) {
      return { executed: false, status: "no_provider_refund", error: "no provider payment reference supplied" };
    }
    const chain = await getProviderForTenant(opts.tenantId);
    const refundCapable = chain.filter((e) => typeof e.provider.refund === "function");
    if (refundCapable.length === 0) {
      return { executed: false, status: "no_provider_refund", error: "no refund-capable provider configured for tenant" };
    }
    const entry = (opts.provider ? refundCapable.find((e) => e.provider.id === opts.provider) : undefined) ?? refundCapable[0]!;
    // W38 (PAY-2): one deterministic key per logical refund — a retry carries
    // the SAME key, and every attempt is journaled in refund_attempts.
    const idempotencyKey = refundIdempotencyKey({
      tenantId: opts.tenantId,
      refundId: opts.refundId,
      reference: opts.reference,
      amountCents: opts.amountCents,
    });
    const result: RefundResult = await entry.provider.refund!(
      {
        tenantId: opts.tenantId,
        reference: opts.reference,
        amountCents: opts.amountCents,
        currency: opts.currency,
        reason: opts.reason,
        metadata: { ...(opts.metadata ?? {}), idempotencyKey },
      },
      entry.creds,
    );
    await recordRefundAttempt(db, {
      tenantId: opts.tenantId,
      refundId: opts.refundId,
      orderId: opts.orderId,
      provider: result.provider,
      providerRef: result.refundReference,
      idempotencyKey,
      amountCents: opts.amountCents,
      currency: opts.currency,
      status: result.ok ? result.status : result.ambiguous ? "ambiguous" : "failed",
      error: result.error,
    });
    return {
      executed: result.ok,
      status: result.ok ? result.status : "failed",
      provider: result.provider,
      refundReference: result.refundReference,
      error: result.error,
      ambiguous: result.ambiguous,
      idempotencyKey,
    };
  } catch (err: any) {
    return { executed: false, status: "failed", error: String(err?.message ?? err) };
  }
}

/**
 * W38 (PAY-2): resolve the order's original payment and ask the provider
 * whether a refund already exists for it. Used by the SLA refund sweep
 * (verify-first) so a provider timeout NEVER triggers a blind retry.
 */
export async function verifyOrderRefund(
  db: Db,
  opts: { tenantId: string; orderId: string; provider?: string },
): Promise<VerifyRefundResult> {
  try {
    const original = await resolveOriginalPayment(db, opts.tenantId, opts.orderId);
    if (!original?.reference) return { state: "unknown", provider: opts.provider ?? "", error: "no completed provider payment reference found for order" };
    return verifyProviderRefund({ tenantId: opts.tenantId, reference: original.reference, provider: opts.provider ?? (original.provider || undefined) });
  } catch (err: any) {
    return { state: "unknown", provider: opts.provider ?? "", error: String(err?.message ?? err) };
  }
}

/**
 * Execute a provider refund for an order payment. Never throws — failures
 * are reported via the outcome so callers record honest refund state.
 */
export async function executeProviderRefund(
  db: Db,
  opts: { tenantId: string; orderId: string; amountCents: number; currency: string; reason?: string; refundId?: string },
): Promise<ProviderRefundOutcome> {
  try {
    const original = await resolveOriginalPayment(db, opts.tenantId, opts.orderId);
    if (!original?.reference) {
      return { executed: false, status: "no_provider_refund", error: "no completed provider payment reference found for order" };
    }
    // Prefer the provider that took the original payment; the by-reference
    // helper falls back to any refund-capable adapter in the tenant's chain.
    return executeProviderRefundByReference(db, {
      tenantId: opts.tenantId,
      reference: original.reference,
      provider: original.provider || undefined,
      amountCents: opts.amountCents,
      currency: opts.currency,
      reason: opts.reason,
      metadata: { orderId: opts.orderId },
      refundId: opts.refundId,
      orderId: opts.orderId,
    });
  } catch (err: any) {
    return { executed: false, status: "failed", error: String(err?.message ?? err) };
  }
}
