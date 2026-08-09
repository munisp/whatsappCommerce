/**
 * server/services/creditRepayLink.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-8 credit repayment rails:
 *
 *   createRepaymentLink  → buyer-facing Paystack link that pays down a
 *                          trade-credit account (full outstanding or partial).
 *                          Backed by a paymentIntents row whose metadata
 *                          { kind: 'credit_repayment', accountId, poId? } is
 *                          what the paymentConfirm post-success hook keys on —
 *                          the SAME claim-first money path as every other
 *                          provider payment.
 *
 *   runCreditRepaymentHook → called from paymentConfirm.confirmProviderPayment
 *                          after a successful claim-first confirm. Applies the
 *                          repayment to the credit account via S1's
 *                          tradeCredit.applyRepayment, EXACTLY-ONCE: the
 *                          processed_webhook_events dedupe ledger is claimed
 *                          (insert-first, PK collision = duplicate) BEFORE the
 *                          apply, so a replayed webhook never double-applies.
 *                          On apply failure the claim is rolled back so a
 *                          later replay/reconciliation can retry. Never throws
 *                          into paymentConfirm — the payment is already
 *                          confirmed.
 *
 * S1 (tradeCredit) and S2 (purchase_orders) merge independently: the credit
 * account is read with RAW SQL and applyRepayment is loaded through an
 * indirection that tests can stub.
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { paymentIntents, processedWebhookEvents } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { claimWebhookEvent } from "./webhookDedupe";
import { recordUsage } from "./metering";

// ── Usage-metering metrics ───────────────────────────────────────────────────
export const METRIC_CREDIT_REPAYMENT_LINKS = "credit_repayment_links";
export const METRIC_CREDIT_REPAYMENTS_APPLIED = "credit_repayments_applied";

// ── Typed error (router maps .code → TRPC code) ──────────────────────────────
export type CreditRepayErrorCode =
  | "credit-account-not-found"
  | "credit-account-forbidden"
  | "nothing-outstanding"
  | "invalid-amount"
  | "amount-exceeds-outstanding"
  | "paystack-not-configured"
  | "paystack-init-failed";

export class CreditRepayError extends Error {
  readonly code: CreditRepayErrorCode;
  constructor(code: CreditRepayErrorCode, message: string) {
    super(message);
    this.name = "CreditRepayError";
    this.code = code;
  }
}

// ── S1 contract: applyRepayment ──────────────────────────────────────────────
import { applyRepayment } from "./tradeCredit/index";

export type ApplyRepaymentFn = typeof applyRepayment;

let applyRepaymentOverride: ApplyRepaymentFn | null = null;

/** Test hook: inject a fake applyRepayment (unit isolation). */
export function __setApplyRepaymentForTests(fn: ApplyRepaymentFn | null): void {
  applyRepaymentOverride = fn;
}

async function loadApplyRepayment(): Promise<ApplyRepaymentFn> {
  return applyRepaymentOverride ?? applyRepayment;
}

// ── Raw-SQL credit account read (S2/S1 table — no schema import) ─────────────
export interface CreditAccountRow {
  id: string;
  tenantId: string; // buyer tenant that owns the account
  outstandingCents: number;
  currency: string;
}

export async function loadCreditAccount(db: any, accountId: string): Promise<CreditAccountRow | null> {
  const res: any = await db.execute(sql`
    SELECT * FROM credit_accounts WHERE id = ${accountId} LIMIT 1
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(res) ? res : (res?.rows ?? []);
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    // S1 credit_accounts: buyer_tenant_id owns the account (raw SQL, no schema import).
    tenantId: String(r.buyer_tenant_id ?? r.buyerTenantId ?? r.tenant_id ?? r.tenantId ?? ""),
    outstandingCents: Number(r.outstanding_cents ?? r.outstandingCents ?? 0),
    currency: String(r.currency ?? "NGN").toUpperCase(),
  };
}

// ── Repayment link creation ──────────────────────────────────────────────────
export interface CreateRepaymentLinkInput {
  /** BUYER tenant (owning the credit account) — router asserts access first. */
  buyerTenantId: string;
  accountId: string;
  /** Partial amount; omitted → full outstanding. */
  amountCents?: number | null;
  poId?: string | null;
  customerPhone?: string | null;
}

export interface RepaymentLinkResult {
  paymentIntentId: string;
  reference: string;
  paymentUrl: string;
  amountCents: number;
  currency: string;
  outstandingCents: number;
}

export async function createRepaymentLink(
  db: any,
  input: CreateRepaymentLinkInput,
): Promise<RepaymentLinkResult> {
  const account = await loadCreditAccount(db, input.accountId);
  if (!account) throw new CreditRepayError("credit-account-not-found", `credit account ${input.accountId} not found`);
  if (account.tenantId !== input.buyerTenantId) {
    throw new CreditRepayError("credit-account-forbidden", "credit account does not belong to this tenant");
  }
  const outstanding = account.outstandingCents;
  if (!(outstanding > 0)) {
    throw new CreditRepayError("nothing-outstanding", "credit account has no outstanding balance");
  }
  const amountCents = input.amountCents ?? outstanding;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new CreditRepayError("invalid-amount", "amountCents must be a positive integer");
  }
  if (amountCents > outstanding) {
    throw new CreditRepayError(
      "amount-exceeds-outstanding",
      `amount ${amountCents} exceeds outstanding balance ${outstanding}`,
    );
  }

  const paystackKey = ENV.paystackSecretKey;
  if (!paystackKey) throw new CreditRepayError("paystack-not-configured", "PAYSTACK_SECRET_KEY not configured");

  const amountMajor = amountCents / 100;
  const paymentIntentId = randomUUID();
  const reference = `CRP-${Date.now()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
  const metadata: Record<string, unknown> = {
    kind: "credit_repayment",
    accountId: input.accountId,
    ...(input.poId ? { poId: input.poId } : {}),
    tenantId: input.buyerTenantId,
    ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
  };
  const now = new Date();

  // The intent row is what the Paystack webhook resolves (by reference) and
  // what carries the credit_repayment metadata into the post-confirm hook.
  // paymentIntents.orderId/customerId are NOT NULL — the PO (or account) id
  // stands in for orderId; there is no storefront order behind a repayment.
  await db.insert(paymentIntents).values({
    id: paymentIntentId,
    tenantId: input.buyerTenantId,
    orderId: input.poId ?? input.accountId,
    customerId: input.customerPhone ?? input.accountId,
    amount: amountMajor.toFixed(2),
    currency: account.currency,
    provider: "paystack",
    providerPaymentId: reference,
    idempotencyKey: `credit-repayment:${paymentIntentId}`,
    status: "pending",
    metadata,
    createdAt: now,
    updatedAt: now,
  });

  let paymentUrl: string;
  try {
    const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `${(input.customerPhone ?? input.accountId).replace(/\D/g, "") || "credit"}@wa.commerce`,
        amount: amountCents, // Paystack minor units (kobo) == cents
        currency: account.currency,
        reference,
        metadata: {
          payment_intent_id: paymentIntentId,
          tenant_id: input.buyerTenantId,
          kind: "credit_repayment",
          accountId: input.accountId,
          ...(input.poId ? { poId: input.poId } : {}),
        },
        callback_url: `${ENV.appUrl}/api/webhooks/paystack/callback`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!psRes.ok) throw new Error(`HTTP ${psRes.status}: ${(await psRes.text().catch(() => "")).slice(0, 200)}`);
    const psData = (await psRes.json()) as { status: boolean; data?: { authorization_url?: string } };
    if (!psData.status || !psData.data?.authorization_url) throw new Error("Paystack returned status=false");
    paymentUrl = psData.data.authorization_url;
  } catch (err: any) {
    // Leave a failed intent for audit rather than a dangling 'pending' one.
    await db
      .update(paymentIntents)
      .set({ status: "failed", failureReason: `paystack_init: ${String(err?.message ?? err).slice(0, 300)}`, updatedAt: new Date() })
      .where(eq(paymentIntents.id, paymentIntentId))
      .catch(() => {});
    throw new CreditRepayError("paystack-init-failed", `Paystack initialization failed: ${err?.message ?? err}`);
  }

  await db
    .update(paymentIntents)
    .set({ status: "initiated", metadata: { ...metadata, paymentUrl }, updatedAt: new Date() })
    .where(eq(paymentIntents.id, paymentIntentId));

  // Ops metering (never throws).
  await recordUsage(db, input.buyerTenantId, METRIC_CREDIT_REPAYMENT_LINKS);

  return { paymentIntentId, reference, paymentUrl, amountCents, currency: account.currency, outstandingCents: outstanding };
}

// ── Post-confirm hook (called from paymentConfirm) ───────────────────────────
export interface CreditRepaymentHookInput {
  tenantId: string;
  /** Provider payment reference (paymentIntents.providerPaymentId). */
  reference: string;
  /** Confirmed amount in MAJOR currency units (verified against the intent). */
  amountMajor: number;
  metadata: Record<string, unknown> | null;
}

export interface CreditRepaymentHookResult {
  applied: boolean;
  reason?: string;
  outstandingAfter?: number;
}

export async function runCreditRepaymentHook(
  db: any,
  input: CreditRepaymentHookInput,
): Promise<CreditRepaymentHookResult> {
  const metadata = input.metadata ?? {};
  if (metadata.kind !== "credit_repayment") return { applied: false, reason: "not-repayment" };
  const accountId = typeof metadata.accountId === "string" ? metadata.accountId : null;
  if (!accountId) return { applied: false, reason: "no-account-id" };

  // Exactly-once: insert-first claim against the dedupe ledger. A replayed
  // webhook collides on the PK and is skipped — it can NEVER double-apply.
  const claimId = `credit-repayment:${input.reference}`.slice(0, 64);
  const claim = await claimWebhookEvent(db, { id: claimId, tenantId: input.tenantId, type: "credit_repayment" });
  if (claim === "duplicate") {
    console.info(`[credit-repay] ref=${input.reference} already applied — replay skipped`);
    return { applied: false, reason: "duplicate" };
  }

  try {
    const applyRepayment = await loadApplyRepayment();
    const amountCents = Math.round(input.amountMajor * 100);
    const res = await applyRepayment({ accountId, amountCents, ref: input.reference });
    await recordUsage(db, input.tenantId, METRIC_CREDIT_REPAYMENTS_APPLIED);
    console.log(
      `[credit-repay] applied ${amountCents}¢ to account ${accountId} (ref=${input.reference}); outstanding after=${res.outstandingAfter}`,
    );
    return { applied: true, outstandingAfter: res.outstandingAfter };
  } catch (err: any) {
    // Roll back the dedupe claim so a webhook replay / reconciliation sweep
    // can retry the apply. Best-effort: never mask the original error.
    await db
      .delete(processedWebhookEvents)
      .where(eq(processedWebhookEvents.id, claimId))
      .catch((delErr: any) => console.error("[credit-repay] claim rollback failed:", delErr?.message));
    console.error(`[credit-repay] applyRepayment failed for ref=${input.reference}:`, err?.message);
    throw err;
  }
}
