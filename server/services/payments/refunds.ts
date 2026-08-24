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
import { eq, and, desc, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { paymentIntents, paymentTransactions } from "../../../drizzle/schema";
import { getProviderForTenant } from "./providers/registry";
import type { RefundResult } from "./providers/types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ProviderRefundOutcome {
  /** True when a provider refund API was actually invoked and accepted. */
  executed: boolean;
  status: "processed" | "pending" | "failed" | "no_provider_refund";
  provider?: string;
  refundReference?: string;
  error?: string;
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

/**
 * Execute a provider refund for an order payment. Never throws — failures
 * are reported via the outcome so callers record honest refund state.
 */
export async function executeProviderRefund(
  db: Db,
  opts: { tenantId: string; orderId: string; amountCents: number; currency: string; reason?: string },
): Promise<ProviderRefundOutcome> {
  try {
    const original = await resolveOriginalPayment(db, opts.tenantId, opts.orderId);
    if (!original?.reference) {
      return { executed: false, status: "no_provider_refund", error: "no completed provider payment reference found for order" };
    }
    const chain = await getProviderForTenant(opts.tenantId);
    // Prefer the provider that took the original payment; fall back to any
    // refund-capable adapter in the tenant's chain.
    const refundCapable = chain.filter((e) => typeof e.provider.refund === "function");
    if (refundCapable.length === 0) {
      return { executed: false, status: "no_provider_refund", error: "no refund-capable provider configured for tenant" };
    }
    const entry = (original.provider ? refundCapable.find((e) => e.provider.id === original.provider) : undefined) ?? refundCapable[0]!;
    const result: RefundResult = await entry.provider.refund!(
      {
        tenantId: opts.tenantId,
        reference: original.reference,
        amountCents: opts.amountCents,
        currency: opts.currency,
        reason: opts.reason,
        metadata: { orderId: opts.orderId },
      },
      entry.creds,
    );
    return {
      executed: result.ok,
      status: result.ok ? result.status : "failed",
      provider: result.provider,
      refundReference: result.refundReference,
      error: result.error,
    };
  } catch (err: any) {
    return { executed: false, status: "failed", error: String(err?.message ?? err) };
  }
}
