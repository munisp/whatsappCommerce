// === W45 money-intents ===
/**
 * server/services/payments/paymentMismatchQuarantine.ts — PAY-13 (W45 Coder B2)
 * ─────────────────────────────────────────────────────────────────────────────
 * PSP under/overpayment quarantine.
 *
 * The PINNED paymentConfirm.ts (md5 2f77ea4816d1adc5cb35473bd35d1697 — never
 * edited) rejects a webhook whose reported amount/currency disagrees with the
 * stored payment record by marking the payment FAILED and returning
 * { ok: false, action: "amount-currency-mismatch" }. But the provider really
 * DID collect money — the pre-W45 flow left those funds unaccounted: no
 * quarantine record, no ops alert, no refund.
 *
 * This service is the ADJACENT SEAM: webhook handlers (server/_core/index.ts
 * call sites of confirmProviderPayment — owned by Coder A1, seam call sites
 * documented for the merger below) invoke `runPaymentMismatchQuarantineHook`
 * when the confirm result is an amount/currency mismatch.
 *
 *   SEAM CALL SITES (server/_core/index.ts, inside the Paystack/Flutterwave
 *   webhook charge.success handlers, immediately after `const result = await
 *   confirmProviderPayment(...)`):
 *
 *     // === W45 money-intents seam (PAY-13) — paymentConfirm.ts PINNED ===
 *     const { runPaymentMismatchQuarantineHook } =
 *       await import("../services/payments/paymentMismatchQuarantine");
 *     await runPaymentMismatchQuarantineHook(db, {
 *       provider: "paystack" | "flutterwave",
 *       reference: ref,
 *       result,
 *       amountMajor: <webhook amount in major units>,
 *       currency: <webhook currency>,
 *       rawPayload: payload.data,
 *     });
 *
 * What the hook does (never throws — the webhook ack must not depend on it):
 *   1. Insert a payment_mismatch_quarantine row (idempotent on reference).
 *   2. Ops alert: captureException severity=critical (observability ring +
 *      ERROR_WEBHOOK sink) + best-effort notifyOwner.
 *   3. Auto-refund the ACTUAL collected amount via executeProviderRefund
 *      (provider refund API, W30 path — refund_attempts journaled with the
 *      deterministic idempotency key). The quarantine row tracks the refund
 *      outcome (auto_refund_initiated / auto_refund_paid / auto_refund_failed).
 */
import { eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { paymentIntents, paymentTransactions, paymentMismatchQuarantine } from "../../../drizzle/schema";
import { captureException } from "../observability";
import { toMinorUnits } from "./currencyExponent";
import { executeProviderRefundByReference } from "./refunds";
import { honestRefundVocabulary } from "./refunds";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface QuarantineOutcome {
  quarantined: boolean;
  quarantineId?: string;
  /** True when the row already existed (webhook replay — no double-refund). */
  duplicate?: boolean;
  refundStatus?: string;
  refundVocabulary?: string;
  reason?: string;
}

/**
 * Quarantine a mismatched PSP payment and attempt the auto-refund.
 * Idempotent on `reference` (unique constraint + onConflictDoNothing): a
 * replayed webhook NEVER double-refunds. Never throws.
 */
export async function quarantinePaymentMismatch(
  db: Db,
  opts: {
    tenantId: string;
    reference: string;
    provider: string;
    expectedAmountMajor: number;
    expectedCurrency: string;
    actualAmountMajor: number | null;
    actualCurrency: string | null;
    paymentIntentId?: string | null;
    orderId?: string | null;
    reason: string;
  },
): Promise<QuarantineOutcome> {
  const expectedMinor = toMinorUnits(opts.expectedAmountMajor, opts.expectedCurrency);
  const actualMinor =
    opts.actualAmountMajor != null && Number.isFinite(opts.actualAmountMajor)
      ? toMinorUnits(opts.actualAmountMajor, opts.actualCurrency ?? opts.expectedCurrency)
      : null;
  try {
    const inserted = await db
      .insert(paymentMismatchQuarantine)
      .values({
        tenantId: opts.tenantId,
        paymentIntentId: opts.paymentIntentId ?? null,
        orderId: opts.orderId ?? null,
        reference: opts.reference,
        provider: opts.provider,
        expectedAmountMinor: expectedMinor,
        actualAmountMinor: actualMinor,
        expectedCurrency: opts.expectedCurrency.toUpperCase(),
        actualCurrency: opts.actualCurrency?.toUpperCase() ?? null,
        reason: opts.reason.slice(0, 2000),
        status: "quarantined",
      })
      .onConflictDoNothing()
      .returning({ id: paymentMismatchQuarantine.id });

    if (inserted.length === 0) {
      return { quarantined: false, duplicate: true, reason: "reference already quarantined" };
    }
    const quarantineId = inserted[0]!.id;

    // Ops alert — money is in hand at the wrong amount; humans must see this
    // even if the auto-refund below succeeds.
    const alertMsg =
      `[PAY-13] payment mismatch quarantined: ${opts.provider} ref=${opts.reference} ` +
      `tenant=${opts.tenantId} expected=${expectedMinor} ${opts.expectedCurrency.toUpperCase()} ` +
      `actual=${actualMinor ?? "?"} ${opts.actualCurrency ?? "?"} — ${opts.reason}`;
    captureException(new Error(alertMsg), {
      service: "payments/paymentMismatchQuarantine",
      operation: "quarantine",
      tenantId: opts.tenantId,
      severity: "critical",
      extra: {
        reference: opts.reference,
        provider: opts.provider,
        orderId: opts.orderId ?? undefined,
        expectedAmountMinor: expectedMinor,
        actualAmountMinor: actualMinor ?? undefined,
      },
    });
    try {
      const { notifyOwner } = await import("../../_core/notification");
      await notifyOwner({ title: "Payment mismatch quarantined (PAY-13)", content: alertMsg });
    } catch { /* best-effort notification; the capture above is authoritative */ }

    // Auto-refund the ACTUAL collected amount back to the buyer (money should
    // not sit in the platform's PSP account for a failed order). Uses the
    // W30 provider-refund path with its deterministic idempotency key, so a
    // retry of THIS call is correlatable and never double-refunds.
    if (actualMinor != null && actualMinor > 0) {
      const refund = await executeProviderRefundByReference(db, {
        tenantId: opts.tenantId,
        reference: opts.reference,
        provider: opts.provider,
        amountCents: actualMinor,
        currency: (opts.actualCurrency ?? opts.expectedCurrency).toUpperCase(),
        reason: `payment_mismatch_quarantine:${quarantineId}`,
        metadata: { quarantineId, mismatch: true },
        orderId: opts.orderId ?? undefined,
      });
      const vocabulary = honestRefundVocabulary(refund);
      const status =
        vocabulary === "refund_paid"
          ? "auto_refund_paid"
          : vocabulary === "refund_initiated"
            ? "auto_refund_initiated"
            : "auto_refund_failed";
      await db
        .update(paymentMismatchQuarantine)
        .set({
          status,
          refundReference: refund.refundReference ?? null,
          updatedAt: new Date(),
        })
        .where(eq(paymentMismatchQuarantine.id, quarantineId));
      if (!refund.executed) {
        captureException(new Error(`[PAY-13] auto-refund NOT executed for quarantined ref=${opts.reference}: ${refund.error ?? refund.status}`), {
          service: "payments/paymentMismatchQuarantine",
          operation: "autoRefund",
          tenantId: opts.tenantId,
          severity: "critical",
          extra: { reference: opts.reference, quarantineId },
        });
      }
      return { quarantined: true, quarantineId, refundStatus: refund.status, refundVocabulary: vocabulary };
    }
    return { quarantined: true, quarantineId, refundStatus: "no_actual_amount" };
  } catch (err: any) {
    // Never throw into the webhook path — but never stay silent either.
    captureException(err, {
      service: "payments/paymentMismatchQuarantine",
      operation: "quarantine",
      tenantId: opts.tenantId,
      severity: "critical",
      extra: { reference: opts.reference },
    });
    return { quarantined: false, reason: String(err?.message ?? err) };
  }
}

/**
 * ADJACENT SEAM hook for the PINNED paymentConfirm.ts. Webhook handlers call
 * this with the confirmProviderPayment result; it no-ops unless the result is
 * an amount/currency mismatch. Resolves the stored payment record (intent or
 * legacy transaction) to derive expected amount/currency + tenant — never
 * trusting the webhook for anything but the actual collected figures.
 */
export async function runPaymentMismatchQuarantineHook(
  db: Db,
  opts: {
    provider: string;
    reference: string;
    result: { ok: boolean; action: string; detail?: string };
    amountMajor: number | null;
    currency: string | null;
    rawPayload?: unknown;
  },
): Promise<QuarantineOutcome | null> {
  if (opts.result.ok || opts.result.action !== "amount-currency-mismatch") return null;
  try {
    const [intent] = await db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.providerPaymentId, opts.reference))
      .limit(1);
    if (intent) {
      return await quarantinePaymentMismatch(db, {
        tenantId: intent.tenantId,
        reference: opts.reference,
        provider: opts.provider,
        expectedAmountMajor: parseFloat(intent.amount),
        expectedCurrency: (intent.currency ?? "NGN").toUpperCase(),
        actualAmountMajor: opts.amountMajor,
        actualCurrency: opts.currency,
        paymentIntentId: intent.id,
        orderId: intent.orderId ?? null,
        reason: opts.result.detail ?? "webhook amount/currency mismatch",
      });
    }
    const [tx] = await db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.providerRef, opts.reference))
      .limit(1);
    if (tx) {
      return await quarantinePaymentMismatch(db, {
        tenantId: tx.tenantId,
        reference: opts.reference,
        provider: opts.provider,
        expectedAmountMajor: parseFloat(tx.amount),
        expectedCurrency: (tx.currency ?? "NGN").toUpperCase(),
        actualAmountMajor: opts.amountMajor,
        actualCurrency: opts.currency,
        orderId: tx.orderId ?? null,
        reason: opts.result.detail ?? "webhook amount/currency mismatch",
      });
    }
    return null;
  } catch (err: any) {
    captureException(err, {
      service: "payments/paymentMismatchQuarantine",
      operation: "hook",
      severity: "critical",
      extra: { reference: opts.reference },
    });
    return null;
  }
}
