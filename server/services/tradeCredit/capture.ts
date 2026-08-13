/**
 * Repayment-at-source capture (W13) — charge-first repayment.
 *
 * When a facility has an ACTIVE mandate, applyMandateRepaymentTx attempts to
 * collect the repayment at source BEFORE falling back to the payment-link
 * flow:
 *
 *   1. EXACTLY-ONCE: the repayment reference
 *      `cr-{accountId}-{yyyymmdd}-{rand}` is claimed insert-first against
 *      the processed_webhook_events dedupe ledger (same claim pattern as
 *      webhookDedupe.claimWebhookEvent). A duplicate claim short-circuits
 *      with reason 'duplicate' — the mandate is NEVER double-charged.
 *   2. chargeOnMandate (metadata { type:'credit_repayment', accountId }).
 *      On success the existing FIFO settlement path (applyRepaymentTx) runs
 *      — outstanding decrement + repayment ledger row + draw settlement all
 *      in one transaction.
 *   3. On charge failure the claim is RELEASED (best-effort delete) so a
 *      later retry can re-claim, a dunning notice is sent to the buyer
 *      (fail-safe), and the caller is told to fall back to the
 *      payment-link flow (services/creditRepayLink.createRepaymentLink).
 *
 * Never throws into the caller.
 */
import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { processedWebhookEvents } from "../../../drizzle/schema";
import { getCreditAccountByIdTx, type TxHandle } from "./accounts";
import { applyRepaymentTx } from "./repayment";
import { chargeOnMandate } from "../payments/mandates";
import { claimWebhookEvent } from "../webhookDedupe";
import { captureException } from "../observability";

export function repaymentReference(accountId: string, now: Date = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = randomInt(0, 1_000_000).toString().padStart(6, "0");
  return `cr-${accountId}-${ymd}-${rand}`.slice(0, 128);
}

export type MandateRepaymentResult =
  | {
      ok: true;
      mode: "mandate";
      reference: string;
      provider?: string;
      status?: "success" | "pending";
      outstandingAfter: number;
    }
  | {
      ok: false;
      mode: "fallback" | "none";
      reason:
        | "no_account"
        | "no_active_mandate"
        | "duplicate"
        | "invalid_amount"
        | "charge_failed"
        | "settlement_failed";
      reference?: string;
      error?: string;
      outstandingAfter: number;
    };

/** Injectable notice sink (dunning fallback) — fail-safe by contract. */
export type DunningNoticeFn = (args: {
  buyerTenantId: string;
  accountId: string;
  amountCents: number;
  reference: string;
  error?: string;
}) => Promise<void>;

async function defaultDunningNotice(args: {
  buyerTenantId: string;
  accountId: string;
  amountCents: number;
  reference: string;
  error?: string;
}): Promise<void> {
  try {
    const { notifyTenantAdminPhone } = await import("../procurement/poFlow");
    const { getDb } = await import("../../db");
    const db = await getDb();
    if (!db) return;
    const naira = (args.amountCents / 100).toLocaleString("en-NG");
    await notifyTenantAdminPhone(
      db,
      args.buyerTenantId,
      `⚠️ We couldn't collect your credit repayment of ₦${naira} from your linked payment mandate ` +
        `(${args.error ?? "charge failed"}). Please complete the repayment via the payment link to ` +
        `keep your credit facility in good standing.`,
    );
  } catch (err: any) {
    console.warn("[tradeCredit/capture] dunning notice failed:", err?.message);
  }
}

let noticeOverride: DunningNoticeFn | null = null;
/** Test hook: inject a fake dunning-notice sink. */
export function __setDunningNoticeForTests(fn: DunningNoticeFn | null): void {
  noticeOverride = fn;
}

/** Release an exactly-once claim after a failed charge (best-effort). */
async function releaseClaim(db: TxHandle, reference: string): Promise<void> {
  try {
    await (db as any).delete(processedWebhookEvents).where(eq(processedWebhookEvents.id, reference));
  } catch (err: any) {
    console.warn(`[tradeCredit/capture] claim release failed for ${reference}:`, err?.message);
  }
}

export async function applyMandateRepaymentTx(
  db: TxHandle,
  args: { accountId: string; amountCents: number; currency?: string },
  now: Date = new Date(),
): Promise<MandateRepaymentResult> {
  try {
    const amountCents = Math.round(args.amountCents);
    const account = await getCreditAccountByIdTx(db, args.accountId);
    if (!account) return { ok: false, mode: "none", reason: "no_account", outstandingAfter: 0 };
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return { ok: false, mode: "none", reason: "invalid_amount", outstandingAfter: account.outstandingCents };
    }
    if (!account.mandateId) {
      return { ok: false, mode: "fallback", reason: "no_active_mandate", outstandingAfter: account.outstandingCents };
    }

    const reference = repaymentReference(account.id, now);
    // Exactly-once claim BEFORE the charge — a duplicate reference never
    // reaches the provider.
    const claim = await claimWebhookEvent(db as any, {
      id: reference,
      tenantId: account.buyerTenantId,
      type: "credit_repayment",
    });
    if (claim === "duplicate") {
      return { ok: false, mode: "none", reason: "duplicate", reference, outstandingAfter: account.outstandingCents };
    }

    const charge = await chargeOnMandate(db, {
      tenantId: account.buyerTenantId,
      mandateId: account.mandateId,
      amountCents,
      currency: args.currency ?? "NGN",
      reference,
      metadata: { type: "credit_repayment", accountId: account.id },
    });

    if (!charge.ok || charge.status === "failed") {
      await releaseClaim(db, reference);
      await (noticeOverride ?? defaultDunningNotice)({
        buyerTenantId: account.buyerTenantId,
        accountId: account.id,
        amountCents,
        reference,
        error: charge.error,
      });
      return {
        ok: false,
        mode: "fallback",
        reason: "charge_failed",
        reference,
        error: charge.error,
        outstandingAfter: account.outstandingCents,
      };
    }

    // Money moved (or is pending at the provider) — settle via the existing
    // claim-first FIFO path.
    const settled = await applyRepaymentTx(db, {
      accountId: account.id,
      amountCents,
      ref: reference,
    }, now);
    if (!settled.ok) {
      // The provider charge succeeded but the local settlement refused (e.g.
      // a concurrent repayment drained outstanding first). Keep the claim so
      // the charge is never retried double; surface for reconciliation.
      console.error(`[tradeCredit/capture] settlement refused after successful charge ${reference}`);
      return {
        ok: false,
        mode: "none",
        reason: "settlement_failed",
        reference,
        outstandingAfter: settled.outstandingAfter,
      };
    }
    return {
      ok: true,
      mode: "mandate",
      reference,
      provider: charge.provider,
      status: charge.status === "pending" ? "pending" : "success",
      outstandingAfter: settled.outstandingAfter,
    };
  } catch (err: any) {
    console.error("[tradeCredit/capture] applyMandateRepaymentTx failed:", err?.message);
    captureException(err, {
      service: "tradeCredit/capture",
      operation: "applyMandateRepayment",
      severity: "error",
      extra: { accountId: args.accountId },
    });
    return { ok: false, mode: "none", reason: "charge_failed", error: err?.message, outstandingAfter: 0 };
  }
}
