// === W45 money-intents ===
/**
 * server/services/payments/duplicateCompletedPayments.ts — PAY-25 (W45 Coder B2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Duplicate-completed-payment detector.
 *
 * Before W45 the provider-chain fallback could mint TWO live checkouts for
 * one payment intent (fallback on timeout, same reference, no verify/void of
 * provider A) — and a determined buyer could pay BOTH. Two completed payments
 * for one order means the second collection must be returned.
 *
 * `detectDuplicateCompletedPayments(db, {tenantId, orderId})`:
 *   1. Find ALL completed payment intents for the order.
 *   2. When more than one exists, keep the EARLIEST completion as the
 *      legitimate payment; every later completion is a duplicate.
 *   3. For each duplicate: auto-refund its full amount via the W30
 *      executeProviderRefund path (deterministic idempotency key — replays
 *      never double-refund) and stamp metadata.duplicateRefund so the
 *      detector is idempotent.
 *   4. Ops alert (captureException critical + best-effort notifyOwner) for
 *      every duplicate found — duplicates indicate a fallback/void bug
 *      upstream and always warrant human review.
 *
 * Never throws — it runs AFTER the legitimate payment is already confirmed.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { paymentIntents } from "../../../drizzle/schema";
import { captureException } from "../observability";
import { executeProviderRefundByReference } from "./refunds";
import { toMinorUnits } from "./currencyExponent";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface DuplicateDetectionOutcome {
  checked: number;
  duplicatesFound: number;
  refundsInitiated: number;
}

export async function detectDuplicateCompletedPayments(
  db: Db,
  opts: { tenantId: string; orderId: string },
): Promise<DuplicateDetectionOutcome> {
  const out: DuplicateDetectionOutcome = { checked: 0, duplicatesFound: 0, refundsInitiated: 0 };
  try {
    const completed = await db
      .select()
      .from(paymentIntents)
      .where(and(
        eq(paymentIntents.tenantId, opts.tenantId),
        eq(paymentIntents.orderId, opts.orderId),
        eq(paymentIntents.status, "completed"),
      ))
      .orderBy(asc(paymentIntents.completedAt));
    out.checked = completed.length;
    if (completed.length <= 1) return out;

    // Earliest completion stands; everything after it is a duplicate payment.
    for (const dup of completed.slice(1)) {
      const meta = (dup.metadata ?? {}) as Record<string, unknown>;
      if (meta.duplicateRefundProcessed === true) continue; // idempotent
      out.duplicatesFound += 1;

      const reference =
        (dup.providerPaymentId ?? "") ||
        (typeof meta.reference === "string" ? (meta.reference as string) : "");
      const currency = (dup.currency ?? "NGN").toUpperCase();
      const amountMinor = toMinorUnits(parseFloat(dup.amount), currency);
      const provider = String(dup.provider ?? meta.servedProvider ?? "");

      const alertMsg =
        `[PAY-25] duplicate completed payment detected: order=${opts.orderId} tenant=${opts.tenantId} ` +
        `duplicate intent=${dup.id} ref=${reference} ${amountMinor} ${currency} via ${provider} — auto-refunding`;
      captureException(new Error(alertMsg), {
        service: "payments/duplicateCompletedPayments",
        operation: "duplicateDetected",
        tenantId: opts.tenantId,
        severity: "critical",
        extra: { orderId: opts.orderId, duplicateIntentId: dup.id, reference },
      });
      try {
        const { notifyOwner } = await import("../../_core/notification");
        await notifyOwner({ title: "Duplicate payment auto-refund (PAY-25)", content: alertMsg });
      } catch { /* best-effort */ }

      if (reference) {
        const refund = await executeProviderRefundByReference(db, {
          tenantId: opts.tenantId,
          reference,
          provider: provider || undefined,
          amountCents: amountMinor,
          currency,
          reason: `duplicate_completed_payment:${dup.id}`,
          metadata: { duplicateOfOrder: opts.orderId, duplicateIntentId: dup.id },
          orderId: opts.orderId,
        });
        if (refund.executed) out.refundsInitiated += 1;
        await db
          .update(paymentIntents)
          .set({
            metadata: sql`COALESCE(${paymentIntents.metadata}, '{}'::jsonb) || ${JSON.stringify({
              duplicateRefundProcessed: true,
              duplicateRefundStatus: refund.status,
              duplicateRefundReference: refund.refundReference ?? null,
              duplicateRefundError: refund.error ?? null,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, dup.id));
        if (!refund.executed) {
          captureException(new Error(`[PAY-25] duplicate auto-refund NOT executed for intent ${dup.id}: ${refund.error ?? refund.status}`), {
            service: "payments/duplicateCompletedPayments",
            operation: "autoRefund",
            tenantId: opts.tenantId,
            severity: "critical",
            extra: { orderId: opts.orderId, duplicateIntentId: dup.id, reference },
          });
        }
      } else {
        // No provider reference to refund against — still flag for humans.
        await db
          .update(paymentIntents)
          .set({
            metadata: sql`COALESCE(${paymentIntents.metadata}, '{}'::jsonb) || ${JSON.stringify({
              duplicateRefundProcessed: true,
              duplicateRefundStatus: "no_reference",
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, dup.id));
      }
    }
    return out;
  } catch (err: any) {
    captureException(err, {
      service: "payments/duplicateCompletedPayments",
      operation: "detect",
      tenantId: opts.tenantId,
      severity: "error",
      extra: { orderId: opts.orderId },
    });
    return out;
  }
}
