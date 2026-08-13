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
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { creditLedger, processedWebhookEvents } from "../../../drizzle/schema";
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
        | "exceeds_outstanding"
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
    // Over-repayment guard BEFORE any provider charge: without it a
    // double-submitted repayment (fresh random reference each call, so the
    // exactly-once claim cannot catch it) would charge the mandate and only
    // THEN be refused by applyRepaymentTx's claim-first guard — money moved
    // with no settlement. Refuse up front instead; the provider is never
    // called (no charge, no dunning notice).
    if (amountCents > account.outstandingCents) {
      return { ok: false, mode: "none", reason: "exceeds_outstanding", outstandingAfter: account.outstandingCents };
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
      // a concurrent repayment drained outstanding first): money moved with
      // no settlement. W14 hardening — (a) CRITICAL observability capture so
      // the ops webhook/ring surfaces it immediately (redacted per
      // observability rules), (b) persist a durable settlement_retry marker
      // on the credit ledger so the gap survives restarts and can be
      // re-attempted exactly-once via retrySettlement / the
      // tradeCredit.retrySettlement admin procedure. The processed-event
      // claim is KEPT so the charge itself is never retried double.
      captureException(new Error(`settlement refused after successful mandate charge ${reference}`), {
        service: "tradeCredit/capture",
        operation: "mandateRepaymentSettlement",
        tenantId: account.buyerTenantId,
        severity: "critical",
        extra: {
          accountId: account.id,
          reference,
          amountCents,
          provider: charge.provider,
          providerStatus: charge.status,
        },
      });
      await persistSettlementRetryMarker(db, account.id, reference, amountCents, now);
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

// ── W14: settlement-retry durable marker + admin retry ─────────────────────
// No schema change: the marker rides the append-only credit_ledger as a
// zero-amount 'adjustment' note (same convention as limit-increase requests
// and [dun:...] dunning markers). kind='adjustment' rows consume nothing in
// the FIFO pool (only invoice_draw/repayment rows do), so the marker never
// distorts settlement math. `ref` carries the repayment reference and the
// note carries the pending amount as JSON after the marker prefix.
const SETTLEMENT_RETRY_PREFIX = "[settlement_retry] ";

function settlementRetryNote(amountCents: number): string {
  return `${SETTLEMENT_RETRY_PREFIX}${JSON.stringify({ amountCents })}`;
}

function parseSettlementRetryNote(note: string | null): number | null {
  if (!note || !note.startsWith(SETTLEMENT_RETRY_PREFIX)) return null;
  try {
    const parsed = JSON.parse(note.slice(SETTLEMENT_RETRY_PREFIX.length));
    const amt = Number(parsed?.amountCents);
    return Number.isFinite(amt) && amt > 0 ? Math.round(amt) : null;
  } catch {
    return null;
  }
}

/** Persist the settlement_retry marker (best-effort — never throws). */
async function persistSettlementRetryMarker(
  db: TxHandle,
  accountId: string,
  reference: string,
  amountCents: number,
  now: Date,
): Promise<void> {
  try {
    await db.insert(creditLedger).values({
      creditAccountId: accountId,
      kind: "adjustment",
      amountCents: 0,
      ref: reference.slice(0, 128),
      note: settlementRetryNote(amountCents),
      createdAt: now,
    });
  } catch (err: any) {
    console.warn(`[tradeCredit/capture] settlement_retry marker persist failed for ${reference}:`, err?.message);
  }
}

export type SettlementRetryStatus =
  | "settled" // the retry applied the repayment (outstanding decremented)
  | "already_settled" // a repayment row with this reference already exists — no-op
  | "no_pending_retry" // no settlement_retry marker and no amount given
  | "settlement_refused"; // applyRepaymentTx refused again (marker restored)

export interface SettlementRetryResult {
  ok: boolean;
  status: SettlementRetryStatus;
  reference: string;
  outstandingAfter?: number;
}

/**
 * Admin-invokable exactly-once re-attempt of a charge-success/settle-fail
 * repayment (see the settlement-fail branch above). Idempotent:
 *
 *   1. A 'repayment' ledger row already carrying `reference` → the money is
 *      settled; any lingering marker is cleaned up and the call is a no-op
 *      ('already_settled').
 *   2. Otherwise the settlement_retry marker is CLAIMED FIRST (DELETE ...
 *      RETURNING) — only one concurrent caller can win the claim, so a
 *      double-invocation can never settle twice.
 *   3. applyRepaymentTx re-runs the claim-first FIFO settlement with the
 *      SAME reference. On refusal the marker is restored (best-effort) so a
 *      later retry remains possible.
 *
 * Never throws into the caller.
 */
export async function retrySettlement(
  db: TxHandle,
  args: { accountId: string; reference: string; amountCents?: number },
  now: Date = new Date(),
): Promise<SettlementRetryResult> {
  const reference = (args.reference ?? "").trim();
  try {
    if (!args.accountId || !reference) {
      return { ok: false, status: "no_pending_retry", reference };
    }
    // (1) Already settled? — exactly-once guard.
    const rows = await (db as any)
      .select({ kind: creditLedger.kind, ref: creditLedger.ref, note: creditLedger.note })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.creditAccountId, args.accountId),
          inArray(creditLedger.kind, ["invoice_draw", "repayment", "adjustment"]),
        ),
      )
      .orderBy(asc(creditLedger.createdAt));
    const settledRow = (rows as any[]).find((r) => r.kind === "repayment" && r.ref === reference);
    if (settledRow) {
      await claimSettlementRetryMarker(db, args.accountId, reference); // clean lingering marker
      return { ok: true, status: "already_settled", reference };
    }
    // (2) Claim the pending marker (claim-first delete ⇒ single winner).
    const claimed = await claimSettlementRetryMarker(db, args.accountId, reference);
    const amountCents = parseSettlementRetryNote(claimed?.note ?? null) ?? (
      Number.isFinite(args.amountCents) && (args.amountCents as number) > 0
        ? Math.round(args.amountCents as number)
        : null
    );
    if (amountCents == null) {
      return { ok: false, status: "no_pending_retry", reference };
    }
    // (3) Re-attempt the claim-first FIFO settlement with the same ref.
    const settled = await applyRepaymentTx(db, {
      accountId: args.accountId,
      amountCents,
      ref: reference,
    }, now);
    // W14.1: lost the insert race against a concurrent retry — the unique
    // index (0052) already guarantees exactly-once, so report already_settled
    // and clean any lingering marker (belt-and-braces with step 1's read,
    // which can miss a just-committed concurrent insert).
    if (settled.ok && settled.alreadySettled) {
      await claimSettlementRetryMarker(db, args.accountId, reference);
      return { ok: true, status: "already_settled", reference, outstandingAfter: settled.outstandingAfter };
    }
    if (!settled.ok) {
      // Restore the marker so the retry stays pending for a later attempt.
      await persistSettlementRetryMarker(db, args.accountId, reference, amountCents, now);
      return { ok: false, status: "settlement_refused", reference, outstandingAfter: settled.outstandingAfter };
    }
    return { ok: true, status: "settled", reference, outstandingAfter: settled.outstandingAfter };
  } catch (err: any) {
    captureException(err, {
      service: "tradeCredit/capture",
      operation: "retrySettlement",
      severity: "error",
      extra: { accountId: args.accountId, reference },
    });
    return { ok: false, status: "settlement_refused", reference };
  }
}

/**
 * Claim-first delete of the settlement_retry marker row(s) for a reference.
 * Returns the first claimed row (note carries the pending amount), or null.
 */
async function claimSettlementRetryMarker(
  db: TxHandle,
  accountId: string,
  reference: string,
): Promise<{ note: string | null } | null> {
  const deleted = await (db as any)
    .delete(creditLedger)
    .where(
      and(
        eq(creditLedger.creditAccountId, accountId),
        eq(creditLedger.ref, reference),
        eq(creditLedger.kind, "adjustment"),
        like(creditLedger.note, `${SETTLEMENT_RETRY_PREFIX}%`),
      ),
    )
    .returning();
  const rows = Array.isArray(deleted) ? deleted : [];
  return rows.length > 0 ? { note: (rows[0] as any).note ?? null } : null;
}
