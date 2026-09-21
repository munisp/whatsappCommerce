/**
 * === W32 pay-over-time (Coder A) ===
 * Pay Over Time — installment vendor-bill pay (Melio flagship, funded by the
 * trade-credit stack). The merchant opts in per bill via
 * vendorBills.recordPayment({ payOverTime: { installments: 3|6|12 } }).
 *
 * Origination (payBillOverTime):
 *   1. Eligibility is FAIL-CLOSED and honest: requireApprovedKyb (existing
 *      gate) + getMerchantScore >= escrow_config.pay_over_time_min_score.
 *      An ineligible merchant gets a code-tagged rejection; the bill stays
 *      pending and NOTHING moves.
 *   2. The vendor is paid IN FULL TODAY from the platform lending facility —
 *      the exact microLoans funding leg (credit_facilities FOR UPDATE +
 *      conditional decrement, merchant_loan_funding row, TigerBeetle
 *      transfer via ledgerBridgeRequest) INSIDE one transaction. Any failure
 *      (underfunded facility, bridge down) rolls everything back honestly:
 *      no plan, no loan, no funding row, bill untouched. The merchant wallet
 *      is NOT touched by the principal.
 *   3. A merchant_loans row backs the plan (outstanding = principal + fee,
 *      fee = round(principal * fee_bps / 10000), integer cents, fee_bps from
 *      escrow_config). The bill flips to 'paid' honestly (the vendor WAS
 *      paid) with payment_ref `pot:<planId>` and
 *      metadata.financing = "pay_over_time".
 *
 * Repayment (runInstallmentCaptureSweep, cron /api/scheduled/installment-due):
 *   due schedule entries are captured via the EXISTING mandate rails
 *   (chargeOnMandate + processed_webhook_events exactly-once claim, the
 *   capture.ts pattern) with deterministic reference `potcap:<planId>:<seq>`.
 *   A failed capture marks the installment honestly 'overdue' and sends a
 *   WhatsApp dunning notice; the claim is released so the next due sweep
 *   retries per the mandate rules — no blind/fake retries. A successful
 *   capture settles in ONE locked transaction: guarded loan outstanding
 *   decrement + repayment ledger row + facility commitment restored by the
 *   principal portion + TigerBeetle legs (`potrepay:` principal back to the
 *   facility account, `potfee:` fee portion to the platform-fees account,
 *   mirroring the escrow fee leg). Loans past dueAt + DEFAULT_GRACE_DAYS
 *   flip to 'defaulted' (microLoans late/default handling) and the plan
 *   follows.
 *
 * Early settle (settlePlanEarly): single mandate charge for the remaining
 * balance. DOCUMENTED FEE POLICY: by default
 * (escrow_config.pay_over_time_prorate_early_fee = false) the flat fee is
 * fully earned at origination — early settle repays the remaining schedule
 * in full, no fee rebate. When the platform enables prorating, fee slices
 * for installments whose due date is still in the future are waived and the
 * merchant pays remaining principal + fee on the ELAPSED schedule only.
 * Integer math throughout; any rounding remainder rides the last installment.
 *
 * Honest merchant copy: "Vendor paid in full · you're repaying ₦X in N
 * installments" — the vendor never waits.
 *
 * === W45 money-ledger ===
 * PAY-18 (DECISION: post-commit outbox, not a recon job): every TigerBeetle
 * leg (origination funding `potfund:`, repayment `potrepay:`, fee `potfee:`)
 * is now a payment_outbox row (0151) committed IN THE SAME transaction as
 * the PG money mutation, delivered post-commit by processPaymentOutbox with
 * the leg's deterministic reference as the TB idempotency key. A bridge
 * timeout can therefore no longer drift PG↔TB silently — the leg retries to
 * convergence or lands 'dead' with a CRITICAL capture for ops. Chosen over a
 * PG↔TB recon job because the outbox both prevents the drift and repairs it,
 * while recon would only ever detect it after the fact.
 * PAY-19: fee legs post to `platform-fees:${plan.currency}` — per-currency
 * platform fee accounts, never a hardcoded NGN leg for a non-NGN plan.
 * PAY-20: mandate revocation pauses auto-capture (plans flip to 'paused' —
 * the capture sweep never touches them, ending infinite dunning), notifies
 * the merchant on BOTH channels with a re-link CTA + a manual payment-link
 * fallback (pot_manual_settle intent, settled exactly-once by the sweep),
 * and exposes admin cancel/restructure. Re-linking a mandate (confirmMandateTx)
 * auto-resumes paused plans.
 */
import crypto from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  creditFacilities,
  escrowConfig,
  installmentPlans,
  merchantLoanFunding,
  merchantLoanRepayments,
  merchantLoans,
  paymentMandates,
  potCharges,
  tenants,
  vendorBills,
  type InstallmentPlan,
  type MerchantLoan,
} from "../../drizzle/schema";
import { getMerchantScore } from "./creditScore";
import { getDb } from "../db";
import { postDirectLedgerLeg, LedgerBridgeError } from "./ledgerBridge";
import { LedgerAccountError } from "./ledgerAccounts";
import { claimWebhookEvent } from "./webhookDedupe";
import { captureException } from "./observability";
import { enqueuePaymentOutbox, OutboxDefinitiveError } from "./paymentOutbox";
import { DEFAULT_GRACE_DAYS } from "./tradeCredit/microLoans";

type Db = any;
type Tx = any;

export const POT_INSTALLMENT_CHOICES = [3, 6, 12] as const;
export type PotInstallments = (typeof POT_INSTALLMENT_CHOICES)[number];
/** Days between installments (monthly cadence). */
export const INSTALLMENT_PERIOD_DAYS = 30;

/** Bill statuses from which a pay-over-time origination may start. */
const POT_PAYABLE_STATUSES = ["pending", "scheduled", "approved", "overdue", "partially_paid"] as const;

// ── Config (platform escrow_config singleton, fail-closed defaults) ─────────

export interface PayOverTimeConfig {
  minScore: number;
  feeBps: number;
  prorateEarlyFee: boolean;
}

export const DEFAULT_POT_CONFIG: PayOverTimeConfig = {
  minScore: 600,
  feeBps: 250,
  prorateEarlyFee: false,
};

export async function getPayOverTimeConfig(db: Db): Promise<PayOverTimeConfig> {
  try {
    const [cfg] = await db
      .select({
        minScore: escrowConfig.payOverTimeMinScore,
        feeBps: escrowConfig.payOverTimeFeeBps,
        prorateEarlyFee: escrowConfig.payOverTimeProrateEarlyFee,
      })
      .from(escrowConfig)
      .where(eq(escrowConfig.id, 1))
      .limit(1);
    if (!cfg) return DEFAULT_POT_CONFIG;
    return {
      minScore: cfg.minScore ?? DEFAULT_POT_CONFIG.minScore,
      feeBps: cfg.feeBps ?? DEFAULT_POT_CONFIG.feeBps,
      prorateEarlyFee: cfg.prorateEarlyFee ?? DEFAULT_POT_CONFIG.prorateEarlyFee,
    };
  } catch {
    return DEFAULT_POT_CONFIG; // config columns missing pre-0106 → defaults
  }
}

// ── Schedule math (pure, integer cents) ─────────────────────────────────────

export interface ScheduleEntry {
  seq: number;
  dueAt: string; // ISO
  amountCents: number;
  principalCents: number;
  feeCents: number;
  status: "due" | "paid" | "overdue";
  paidAt: string | null;
}

/**
 * Split principal + flat fee into N monthly installments. Fee:
 * round(principal * feeBps / 10000). Per-installment amounts are floored;
 * the rounding remainder rides the LAST installment so the parts always sum
 * exactly to the whole.
 */
export function computeSchedule(
  principalCents: number,
  feeBps: number,
  installments: number,
  now: Date,
): { feeCents: number; totalCents: number; perInstallmentCents: number; schedule: ScheduleEntry[] } {
  if (!Number.isSafeInteger(principalCents) || principalCents <= 0) {
    throw Object.assign(new Error("principal must be a positive integer (cents)"), { code: "BAD_REQUEST" });
  }
  if (!POT_INSTALLMENT_CHOICES.includes(installments as PotInstallments)) {
    throw Object.assign(new Error(`installments must be one of ${POT_INSTALLMENT_CHOICES.join("/")}`), { code: "BAD_REQUEST" });
  }
  const feeCents = Math.round((principalCents * feeBps) / 10_000);
  const totalCents = principalCents + feeCents;
  const perTotal = Math.floor(totalCents / installments);
  const perPrincipal = Math.floor(principalCents / installments);
  const perFee = Math.floor(feeCents / installments);
  const schedule: ScheduleEntry[] = [];
  for (let i = 0; i < installments; i++) {
    const last = i === installments - 1;
    const amount = last ? totalCents - perTotal * (installments - 1) : perTotal;
    const principal = last ? principalCents - perPrincipal * (installments - 1) : perPrincipal;
    const fee = last ? feeCents - perFee * (installments - 1) : perFee;
    schedule.push({
      seq: i + 1,
      dueAt: new Date(now.getTime() + (i + 1) * INSTALLMENT_PERIOD_DAYS * 24 * 3600 * 1000).toISOString(),
      amountCents: amount,
      principalCents: principal,
      feeCents: fee,
      status: "due",
      paidAt: null,
    });
  }
  return { feeCents, totalCents, perInstallmentCents: perTotal, schedule };
}

/**
 * Early-settle amount (pure). Default policy (prorateEarlyFee=false): the
 * flat fee is fully earned at origination — the merchant repays every unpaid
 * installment in full. With prorating enabled, fee slices of unpaid
 * installments whose due date is still in the future are waived (fee on the
 * elapsed schedule only); due/overdue installments are charged in full.
 */
export function earlySettleAmountCents(
  schedule: ScheduleEntry[],
  opts: { prorateEarlyFee: boolean; now: Date },
): number {
  let total = 0;
  for (const e of schedule) {
    if (e.status === "paid") continue;
    const future = new Date(e.dueAt).getTime() > opts.now.getTime();
    total += opts.prorateEarlyFee && future ? e.principalCents : e.amountCents;
  }
  return total;
}

// ── Eligibility (fail-closed) ───────────────────────────────────────────────

export interface PotEligibility {
  eligible: boolean;
  score: number | null;
  minScore: number;
  reason: "ok" | "kyb_not_approved" | "score_below_minimum" | "score_unavailable";
}

export async function checkPayOverTimeEligibility(
  db: Db,
  tenantId: string,
): Promise<PotEligibility> {
  const cfg = await getPayOverTimeConfig(db);
  // KYB gate is fail-closed (throws FORBIDDEN) — translate into an honest verdict.
  try {
    const { requireApprovedKyb } = await import("./kycGate");
    await requireApprovedKyb(tenantId, db);
  } catch {
    return { eligible: false, score: null, minScore: cfg.minScore, reason: "kyb_not_approved" };
  }
  try {
    const { score } = await getMerchantScore(tenantId, tenantId, db);
    if (score < cfg.minScore) {
      return { eligible: false, score, minScore: cfg.minScore, reason: "score_below_minimum" };
    }
    return { eligible: true, score, minScore: cfg.minScore, reason: "ok" };
  } catch {
    return { eligible: false, score: null, minScore: cfg.minScore, reason: "score_unavailable" };
  }
}

// ── Origination: vendor paid in full via the locked facility funding leg ────

export interface PayBillOverTimeResult {
  ok: true;
  billId: string;
  status: string;
  paidCents: number;
  amountCents: number;
  /** Wallet debit — always 0 for pay-over-time (the facility funds it). */
  chargedCents: number;
  paymentRef: string;
  planId: string;
  loanId: string;
  installments: number;
  feeCents: number;
  totalRepayCents: number;
  schedule: ScheduleEntry[];
  duplicate?: boolean;
  message: string;
}

/** Deterministic TigerBeetle idempotency reference for the funding leg. */
export function potFundingRef(loanId: string): string {
  return `potfund:${loanId}`.slice(0, 64);
}

/** Deterministic exactly-once reference for an installment capture. */
export function potCaptureRef(planId: string, seq: number): string {
  return `potcap:${planId}:${seq}`.slice(0, 128);
}

/** Deterministic reference for an early-settle charge. */
export function potSettleRef(planId: string): string {
  return `potsettle:${planId}`.slice(0, 128);
}

// === W45 money-ledger === PAY-18: TigerBeetle legs are post-commit outbox
// deliveries. The PG mutation enqueues the leg atomically; the worker calls
// deliverLedgerOutboxLeg → postLedgerTransfer. TB dedupes on the
// idempotency key (== the outbox reference), so worker retries are no-ops.
async function postLedgerTransfer(
  body: {
    debit_account_id: string;
    credit_account_id: string;
    amount: number;
    idempotency_key: string;
  },
): Promise<void> {
  try {
    // body.*_account_id are domain refs ("credit-facility:<id>", "platform-fees:USD"); the bridge only
    // accepts UUID/decimal ids. A replay of the same key is a 200 (replayed), so anything else that is
    // not 2xx is a real failure: it used to be swallowed as "already posted", which dropped the leg.
    await postDirectLedgerLeg({
      debit_ref: body.debit_account_id,
      credit_ref: body.credit_account_id,
      amount: body.amount,
      idempotency_key: body.idempotency_key,
    });
  } catch (err: any) {
    // A definitive 4xx (malformed leg, or the ledger refusing it) must not burn retries — fail the row
    // so it is visible instead of vanishing. Unreachable/5xx throws and is retried.
    if (err instanceof LedgerBridgeError && err.status != null && err.status >= 400 && err.status < 500) {
      throw new OutboxDefinitiveError(err.message);
    }
    if (err instanceof LedgerAccountError) throw new OutboxDefinitiveError(err.message);
    throw err;
  }
}

/** paymentOutbox deliverer for kind 'ledger_transfer' (PAY-18). */
export async function deliverLedgerOutboxLeg(payload: {
  debit_account_id: string;
  credit_account_id: string;
  amount: number;
  idempotency_key: string;
}): Promise<void> {
  await postLedgerTransfer(payload);
}

/** Enqueue a TigerBeetle leg INSIDE the current money transaction (PAY-18). */
async function enqueueLedgerLeg(
  tx: Tx,
  tenantId: string,
  leg: { debit_account_id: string; credit_account_id: string; amount: number; idempotency_key: string },
): Promise<void> {
  await enqueuePaymentOutbox(tx, {
    tenantId,
    kind: "ledger_transfer",
    reference: leg.idempotency_key.slice(0, 160),
    payload: leg,
  });
}

/**
 * PAY-18 post-commit drain: after the PG money mutation COMMITS, attempt an
 * immediate best-effort outbox delivery (the cron worker remains the durable
 * backstop — a drain failure leaves the row pending for retry; exactly-once
 * by reference either way). Never throws into the money path.
 */
async function drainPaymentOutboxBestEffort(db: Db): Promise<void> {
  try {
    const { processPaymentOutbox } = await import("./paymentOutbox");
    await processPaymentOutbox(db, { batch: 20 });
  } catch (err: any) {
    console.warn("[payOverTime] post-commit outbox drain failed (cron worker retries):", err?.message);
  }
}

function naira(cents: number): string {
  return (cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function potMerchantCopy(totalCents: number, installments: number): string {
  return `Vendor paid in full · you're repaying ₦${naira(totalCents)} in ${installments} installments`;
}

/**
 * Originate a pay-over-time plan for a vendor bill. Called from
 * vendorBills.recordVendorBillPayment AFTER the W31 approval gate (the gate
 * stays first: above-threshold bills park in pending_approval even with
 * payOverTime). Throws code-tagged errors (NOT_FOUND/CONFLICT/BAD_REQUEST/
 * FORBIDDEN) exactly like the wallet path.
 */
export async function payBillOverTime(
  db: Db,
  opts: { tenantId: string; billId: string; installments: PotInstallments; actor?: string | null; now?: Date },
): Promise<PayBillOverTimeResult> {
  const now = opts.now ?? new Date();
  const [bill] = await db.select().from(vendorBills)
    .where(and(eq(vendorBills.id, opts.billId), eq(vendorBills.tenantId, opts.tenantId)));
  if (!bill) throw Object.assign(new Error("Vendor bill not found"), { code: "NOT_FOUND" });
  if (bill.status === "paid") {
    throw Object.assign(new Error(`Bill is already paid (ref ${bill.paymentRef ?? "n/a"})`), { code: "CONFLICT" });
  }
  if (bill.status === "cancelled") {
    throw Object.assign(new Error("Bill is cancelled"), { code: "CONFLICT" });
  }
  if (!POT_PAYABLE_STATUSES.includes(bill.status)) {
    throw Object.assign(new Error(`Bill status "${bill.status}" cannot accept a payment`), { code: "CONFLICT" });
  }
  const remaining = bill.amountCents - bill.paidCents;
  if (remaining <= 0) {
    throw Object.assign(new Error("Bill has no remaining balance"), { code: "CONFLICT" });
  }

  // Eligibility — fail-closed, honest rejection; the bill stays untouched.
  const eligibility = await checkPayOverTimeEligibility(db, opts.tenantId);
  if (!eligibility.eligible) {
    const detail = eligibility.reason === "kyb_not_approved"
      ? "KYB approval is required for pay-over-time"
      : eligibility.reason === "score_below_minimum"
        ? `credit score ${eligibility.score} is below the pay-over-time minimum ${eligibility.minScore}`
        : "credit score unavailable";
    throw Object.assign(new Error(`pay_over_time_ineligible: ${detail}`), { code: "BAD_REQUEST" });
  }

  const cfg = await getPayOverTimeConfig(db);
  const { feeCents, totalCents, perInstallmentCents, schedule } = computeSchedule(
    remaining, cfg.feeBps, opts.installments, now,
  );

  // ONE transaction: locked bill re-check → plan dedupe → facility FOR
  // UPDATE decrement → loan + plan + funding row → TB transfer → bill paid.
  // ANY failure rolls back honestly; the bill is untouched.
  const planId = crypto.randomUUID();
  const result = await db.transaction(async (tx: Tx) => {
    const [fresh] = await tx.select().from(vendorBills)
      .where(and(eq(vendorBills.id, bill.id), eq(vendorBills.tenantId, opts.tenantId)))
      .for("update");
    if (!fresh || !POT_PAYABLE_STATUSES.includes(fresh.status)) {
      throw Object.assign(new Error(`Bill status "${fresh?.status ?? "missing"}" cannot accept a payment`), { code: "CONFLICT" });
    }
    const freshRemaining = fresh.amountCents - fresh.paidCents;
    if (freshRemaining !== remaining) {
      throw Object.assign(new Error("Bill balance changed concurrently — retry"), { code: "CONFLICT" });
    }

    // Idempotent replay: a plan already exists for this bill (the bill row
    // lock serializes originations, so this read is race-safe).
    const [existingPlan] = await tx.select().from(installmentPlans)
      .where(and(
        eq(installmentPlans.vendorBillId, bill.id),
        inArray(installmentPlans.status, ["active", "repaid"]),
      ))
      .limit(1);
    if (existingPlan) {
      const [existingLoan] = await tx.select().from(merchantLoans)
        .where(eq(merchantLoans.id, existingPlan.loanId ?? "")).limit(1);
      return {
        ok: true as const, billId: bill.id, status: fresh.status === "paid" ? "paid" : fresh.status,
        paidCents: fresh.paidCents, amountCents: fresh.amountCents, chargedCents: 0,
        paymentRef: `pot:${existingPlan.id}`, planId: existingPlan.id,
        loanId: existingPlan.loanId ?? "", installments: existingPlan.installments,
        feeCents: existingLoan?.feeCents ?? 0,
        totalRepayCents: (existingLoan?.outstandingCents ?? 0),
        schedule: (existingPlan.schedule as ScheduleEntry[] | null) ?? [],
        duplicate: true,
        message: potMerchantCopy(existingPlan.perInstallmentCents * existingPlan.installments, existingPlan.installments),
      };
    }

    // ── Funding leg (microLoans pattern): lock + atomically decrement the
    // oldest active facility with sufficient remaining commitment.
    const [facility] = await tx.select().from(creditFacilities)
      .where(and(eq(creditFacilities.status, "active"), gte(creditFacilities.commitmentCents, remaining)))
      .orderBy(asc(creditFacilities.createdAt), asc(creditFacilities.id))
      .limit(1)
      .for("update");
    if (!facility) {
      throw Object.assign(new Error("pay_over_time_funding_unavailable: insufficient facility funding"), { code: "BAD_REQUEST" });
    }
    const [funded] = await tx.update(creditFacilities)
      .set({ commitmentCents: sql`${creditFacilities.commitmentCents} - ${remaining}`, updatedAt: now })
      .where(and(eq(creditFacilities.id, facility.id), gte(creditFacilities.commitmentCents, remaining)))
      .returning();
    if (!funded) {
      throw Object.assign(new Error("pay_over_time_funding_unavailable: insufficient facility funding"), { code: "BAD_REQUEST" });
    }

    // Loan backing the plan. repaymentPct 0: the microLoans sale sweep never
    // deducts from a PoT loan (installments are mandate-captured instead);
    // its late/default marking still applies (shared default path).
    const lastDue = new Date(schedule[schedule.length - 1].dueAt);
    const [loan] = await tx.insert(merchantLoans).values({
      tenantId: opts.tenantId,
      merchantId: opts.tenantId,
      status: "active",
      principalCents: remaining,
      feeCents,
      outstandingCents: totalCents,
      repaymentPct: 0,
      scoreAtAccept: eligibility.score ?? 0,
      tier: "POT",
      disbursedAt: now,
      dueAt: lastDue,
    }).returning();

    const ledgerRef = potFundingRef(loan.id);
    await tx.insert(merchantLoanFunding).values({
      loanId: loan.id,
      tenantId: opts.tenantId,
      facilityId: facility.id,
      principalCents: remaining,
      ledgerRef,
    });
    // === W45 money-ledger === PAY-18: the TigerBeetle funding leg is a
    // post-commit outbox row committed atomically with the funding mutation —
    // a bridge outage no longer rolls back (or silently strands) the
    // origination; the worker delivers/retries to convergence and a dead row
    // pages ops (documented at the module header).
    await enqueueLedgerLeg(tx, opts.tenantId, {
      debit_account_id: `credit-facility:${facility.id}`,
      credit_account_id: `vendor-bill:${bill.id}`,
      amount: remaining,
      idempotency_key: ledgerRef,
    });

    await tx.insert(installmentPlans).values({
      id: planId,
      tenantId: opts.tenantId,
      vendorBillId: bill.id,
      principalCents: remaining,
      installments: opts.installments,
      feeBps: cfg.feeBps,
      perInstallmentCents,
      currency: fresh.currency,
      status: "active",
      loanId: loan.id,
      schedule,
    });

    const paymentRef = `pot:${planId}`;
    const [paid] = await tx.update(vendorBills).set({
      paidCents: fresh.amountCents,
      status: "paid",
      paymentRef,
      metadata: {
        ...((fresh.metadata as Record<string, unknown> | null) ?? {}),
        financing: "pay_over_time",
        planId,
        loanId: loan.id,
        installments: opts.installments,
        feeBps: cfg.feeBps,
        feeCents,
        facilityId: facility.id,
      },
      updatedAt: now,
    }).where(and(eq(vendorBills.id, fresh.id), eq(vendorBills.status, fresh.status))).returning();
    if (!paid) throw Object.assign(new Error("Bill changed concurrently — retry"), { code: "CONFLICT" });

    const { appendBillEvent } = await import("./vendorBills");
    await appendBillEvent(tx, bill.id, "payment_recorded", opts.actor ?? null, {
      paymentRef,
      financing: "pay_over_time",
      planId,
      loanId: loan.id,
      chargedCents: 0,
      financedCents: remaining,
      feeCents,
      installments: opts.installments,
      paidCents: fresh.amountCents,
      resultingStatus: "paid",
    });

    return {
      ok: true as const, billId: bill.id, status: "paid",
      paidCents: fresh.amountCents, amountCents: fresh.amountCents, chargedCents: 0,
      paymentRef, planId, loanId: loan.id, installments: opts.installments,
      feeCents, totalRepayCents: totalCents, schedule,
      message: potMerchantCopy(totalCents, opts.installments),
    };
  });
  // PAY-18: the funding leg committed as an outbox row — best-effort drain
  // post-commit (durable retry is the payment-outbox cron worker).
  await drainPaymentOutboxBestEffort(db);
  return result;
}

// ── Installment capture (cron sweep) ────────────────────────────────────────

export interface InstallmentSweepResult {
  plansScanned: number;
  captured: number;
  capturedCents: number;
  overdue: number;
  dunned: number;
  plansRepaid: number;
  plansDefaulted: number;
  skippedDuplicate: number;
  /** === W45 money-ledger === PAY-20: manual payment-link settlements applied. */
  manualSettled: number;
}

async function findActiveMandate(db: Db, tenantId: string) {
  const [m] = await db.select().from(paymentMandates)
    .where(and(eq(paymentMandates.tenantId, tenantId), eq(paymentMandates.status, "active")))
    .orderBy(desc(paymentMandates.createdAt))
    .limit(1);
  return m ?? null;
}

async function sendPotDunning(db: Db, tenantId: string, message: string): Promise<boolean> {
  try {
    const { notifyTenantAdminPhone } = await import("./procurement/poFlow");
    await notifyTenantAdminPhone(db, tenantId, message);
    return true;
  } catch (err: any) {
    console.warn("[payOverTime] dunning notice failed:", err?.message);
    return false;
  }
}

async function releasePotClaim(db: Db, reference: string): Promise<void> {
  try {
    const { processedWebhookEvents } = await import("../../drizzle/schema");
    await db.delete(processedWebhookEvents).where(eq(processedWebhookEvents.id, reference));
  } catch (err: any) {
    console.warn(`[payOverTime] claim release failed for ${reference}:`, err?.message);
  }
}

// ── W38/PAY-4/5/6: durable pot_charges ledger ───────────────────────────────
// Every PoT mandate charge attempt is persisted in pot_charges (0120), keyed
// by the exactly-once charge reference (potcap:/potsettle:). 'pending' and
// 'settlement_failed' rows are converged by reconcilePendingPotCharges via
// the provider's READ-ONLY fetchStatus() — a charge is NEVER blind-retried.
async function persistPotCharge(
  db: Db,
  row: {
    tenantId: string;
    planId: string;
    loanId?: string | null;
    mandateId?: string | null;
    provider: string;
    kind: "installment" | "settle";
    seq?: number | null;
    reference: string;
    amountCents: number;
    currency: string;
    status: "pending" | "success" | "failed" | "settlement_failed";
    providerStatus?: string | null;
    rawResponse?: unknown;
  },
  now: Date = new Date(),
): Promise<void> {
  try {
    await db.insert(potCharges).values({
      tenantId: row.tenantId,
      planId: row.planId,
      loanId: row.loanId ?? null,
      mandateId: row.mandateId ?? null,
      provider: row.provider,
      kind: row.kind,
      seq: row.seq ?? null,
      reference: row.reference,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      providerStatus: row.providerStatus ?? null,
      rawResponse: row.rawResponse === undefined ? null : JSON.parse(JSON.stringify(row.rawResponse)),
      createdAt: now,
      updatedAt: now,
    });
  } catch (err: any) {
    // A duplicate reference means the charge row is already persisted (e.g.
    // a replay or a FRESH attempt after an abandoned settle — the exactly-once
    // reference is unique by design). Exactly-once by constraint, not an
    // error; a terminal 'success' still converges the existing row (never
    // overwrites a prior success).
    const e = err as { code?: string; constraint?: string; message?: string };
    if (e?.code === "23505" || /pot_charges_reference_uniq|duplicate key/i.test(e?.message ?? "")) {
      if (row.status === "success") {
        try {
          await db.update(potCharges)
            .set({ status: "success", providerStatus: row.providerStatus ?? "success", updatedAt: now })
            .where(and(eq(potCharges.reference, row.reference), inArray(potCharges.status, ["pending", "failed", "settlement_failed"])));
        } catch (upErr: any) {
          console.warn(`[payOverTime] pot charge success-converge failed for ${row.reference}:`, upErr?.message);
        }
      }
      return;
    }
    // Persistence must not throw into the money path, but a lost row means
    // the charge can never be reconciled — surface as CRITICAL.
    console.warn(`[payOverTime] pot charge persist failed for ${row.reference}:`, err?.message);
    if (row.status === "pending" || row.status === "settlement_failed") {
      captureException(err, {
        service: "payOverTime",
        operation: "persistPotCharge",
        tenantId: row.tenantId,
        severity: "critical",
        extra: { planId: row.planId, reference: row.reference, kind: row.kind },
      });
    }
  }
}

/** Load the durable pot_charges row for an exactly-once reference. */
async function getPotChargeByRef(db: Db, reference: string) {
  try {
    const [row] = await db.select().from(potCharges).where(eq(potCharges.reference, reference)).limit(1);
    return row ?? null;
  } catch {
    return null; // table not migrated yet — treated as "no durable record"
  }
}

/** Claim-first status flip on a pot_charges row (single winner). */
async function flipPotChargeStatus(
  db: Db,
  id: string,
  from: string[],
  to: string,
  providerStatus: string | null,
  now: Date,
): Promise<boolean> {
  const [flipped] = await db.update(potCharges)
    .set({ status: to, providerStatus, updatedAt: now })
    .where(and(eq(potCharges.id, id), inArray(potCharges.status, from)))
    .returning();
  return !!flipped;
}

/**
 * Settle a successful mandate charge against the plan's loan in ONE locked
 * transaction: guarded outstanding decrement + repayment ledger row +
 * facility commitment restored by the principal portion + TB repayment/fee
 * legs + schedule entry marked paid (+ plan/loan 'repaid' when complete).
 */
async function settleCapturedAmountTx(
  tx: Tx,
  plan: InstallmentPlan,
  loan: MerchantLoan,
  entry: ScheduleEntry,
  amountCents: number,
  reference: string,
  now: Date,
): Promise<{ outstandingAfter: number; repaid: boolean }> {
  const [lockedLoan] = await tx.select().from(merchantLoans)
    .where(eq(merchantLoans.id, loan.id)).limit(1).for("update");
  if (!lockedLoan) throw new Error(`[payOverTime] loan ${loan.id} missing at settlement`);
  const [lockedPlan] = await tx.select().from(installmentPlans)
    .where(eq(installmentPlans.id, plan.id)).limit(1).for("update");

  // Guarded outstanding decrement (never below zero, never above the debit).
  const [updatedLoan] = await tx.update(merchantLoans)
    .set({
      outstandingCents: sql`GREATEST(0, ${merchantLoans.outstandingCents} - ${amountCents})`,
      updatedAt: now,
    })
    .where(and(eq(merchantLoans.id, lockedLoan.id), sql`${merchantLoans.outstandingCents} >= ${amountCents}`))
    .returning();
  if (!updatedLoan) {
    throw new Error(`[payOverTime] outstanding guard refused installment settlement for loan ${lockedLoan.id}`);
  }

  await tx.insert(merchantLoanRepayments).values({
    loanId: lockedLoan.id,
    tenantId: lockedLoan.tenantId,
    amountCents,
    source: "installment",
    reference,
  });

  // Fee/principal legs: restore the facility commitment by the principal
  // portion (the funding becomes lendable again) and enqueue both
  // TigerBeetle transfers as post-commit outbox legs (PAY-18) — principal
  // back to the facility account, fee to the PLAN-CURRENCY platform-fees
  // account (PAY-19: platform-fees:${currency}, never a hardcoded NGN leg).
  const planCurrency = (plan.currency ?? "NGN").toUpperCase();
  const funding = await tx.select().from(merchantLoanFunding)
    .where(eq(merchantLoanFunding.loanId, lockedLoan.id)).limit(1);
  const facilityId = funding[0]?.facilityId ?? null;
  if (facilityId && entry.principalCents > 0) {
    await tx.update(creditFacilities)
      .set({ commitmentCents: sql`${creditFacilities.commitmentCents} + ${entry.principalCents}`, updatedAt: now })
      .where(eq(creditFacilities.id, facilityId));
    await enqueueLedgerLeg(tx, lockedLoan.tenantId, {
      debit_account_id: `mandate-clearing:${lockedLoan.tenantId}`,
      credit_account_id: `credit-facility:${facilityId}`,
      amount: entry.principalCents,
      idempotency_key: `potrepay:${plan.id}:${entry.seq}`.slice(0, 64),
    });
  }
  if (entry.feeCents > 0) {
    await enqueueLedgerLeg(tx, lockedLoan.tenantId, {
      debit_account_id: `mandate-clearing:${lockedLoan.tenantId}`,
      credit_account_id: `platform-fees:${planCurrency}`,
      amount: entry.feeCents,
      idempotency_key: `potfee:${plan.id}:${entry.seq}`.slice(0, 64),
    });
  }

  // Schedule entry → paid; plan/loan → repaid when nothing is left.
  const schedule = ((lockedPlan?.schedule as ScheduleEntry[] | null) ?? []).map((e) =>
    e.seq === entry.seq ? { ...e, status: "paid" as const, paidAt: now.toISOString() } : e);
  const outstandingAfter = updatedLoan.outstandingCents;
  const repaid = outstandingAfter === 0;
  await tx.update(installmentPlans)
    .set({ schedule, ...(repaid ? { status: "repaid" as const } : {}), updatedAt: now })
    .where(eq(installmentPlans.id, plan.id));
  if (repaid) {
    await tx.update(merchantLoans)
      .set({ status: "repaid", repaidAt: now, updatedAt: now })
      .where(and(eq(merchantLoans.id, lockedLoan.id), eq(merchantLoans.outstandingCents, 0)));
  }
  return { outstandingAfter, repaid };
}

export type PotCaptureOutcome =
  | { ok: true; reference: string; outstandingAfter: number; repaid: boolean }
  | { ok: false; reason: "no_mandate" | "duplicate" | "charge_failed" | "settlement_failed"; reference?: string; error?: string };

/**
 * Capture ONE due installment via the existing mandate rails (capture.ts
 * pattern): deterministic exactly-once claim → chargeOnMandate → locked
 * settlement. A definitive charge failure marks the entry 'overdue' and
 * duns via WhatsApp; the claim is released so the next due sweep retries
 * per the mandate rules (never a blind same-tick retry).
 */
export async function captureInstallment(
  db: Db,
  plan: InstallmentPlan,
  entry: ScheduleEntry,
  now: Date = new Date(),
): Promise<PotCaptureOutcome> {
  const reference = potCaptureRef(plan.id, entry.seq);
  const [loan] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId ?? "")).limit(1);
  if (!loan || loan.outstandingCents <= 0) {
    return { ok: false, reason: "settlement_failed", error: "loan_missing_or_repaid" };
  }
  const amountCents = Math.min(entry.amountCents, loan.outstandingCents);

  const mandate = await findActiveMandate(db, plan.tenantId);
  if (!mandate) {
    await markEntryOverdue(db, plan, entry, now);
    await sendPotDunning(db, plan.tenantId,
      `⚠️ We couldn't collect installment ${entry.seq} of your pay-over-time plan (₦${naira(entry.amountCents)}): no active payment mandate is linked. Link a mandate or settle early from the dashboard to keep your plan in good standing.`);
    return { ok: false, reason: "no_mandate" };
  }

  // Exactly-once claim BEFORE the charge (same pattern as capture.ts).
  const claim = await claimWebhookEvent(db, {
    id: reference,
    tenantId: plan.tenantId,
    type: "pot_installment",
  });
  if (claim === "duplicate") return { ok: false, reason: "duplicate", reference };

  const { chargeOnMandate } = await import("./payments/mandates");
  const charge = await chargeOnMandate(db, {
    tenantId: plan.tenantId,
    mandateId: mandate.id,
    amountCents,
    currency: plan.currency ?? "NGN",
    reference,
    metadata: { type: "pot_installment", planId: plan.id, seq: entry.seq },
  });

  if (!charge.ok || charge.status === "failed") {
    // Definitive failure: honest overdue installment + WA dunning; release
    // the claim so the NEXT due sweep retries per the mandate rules.
    await releasePotClaim(db, reference);
    await markEntryOverdue(db, plan, entry, now);
    await sendPotDunning(db, plan.tenantId,
      `⚠️ We couldn't collect installment ${entry.seq} of your pay-over-time plan (₦${naira(entry.amountCents)} — ${charge.error ?? "charge failed"}). We'll retry on the next collection run, or you can settle early from the dashboard. Your vendor was already paid in full.`);
    return { ok: false, reason: "charge_failed", reference, error: charge.error };
  }
  if (charge.status === "pending") {
    // Provider accepted but money has NOT moved: keep the claim and the
    // entry 'due', and persist a DURABLE pending row (W38/PAY-4) so the
    // reconcilePendingPotCharges sweep settles exactly once when the
    // provider confirms — never settled early, never re-charged.
    await persistPotCharge(db, {
      tenantId: plan.tenantId,
      planId: plan.id,
      loanId: loan.id,
      mandateId: mandate.id,
      provider: charge.provider ?? "unknown",
      kind: "installment",
      seq: entry.seq,
      reference,
      amountCents,
      currency: plan.currency ?? "NGN",
      status: "pending",
      providerStatus: "pending",
      rawResponse: { status: "pending" },
    }, now);
    return { ok: false, reason: "duplicate", reference, error: "charge_pending" };
  }

  try {
    const settled = await db.transaction(async (tx: Tx) =>
      settleCapturedAmountTx(tx, plan, loan, entry, amountCents, reference, now));
    await persistPotCharge(db, {
      tenantId: plan.tenantId,
      planId: plan.id,
      loanId: loan.id,
      mandateId: mandate.id,
      provider: charge.provider ?? "unknown",
      kind: "installment",
      seq: entry.seq,
      reference,
      amountCents,
      currency: plan.currency ?? "NGN",
      status: "success",
      providerStatus: "success",
      rawResponse: { status: "success" },
    }, now);
    await drainPaymentOutboxBestEffort(db); // PAY-18 post-commit drain
    return { ok: true, reference, outstandingAfter: settled.outstandingAfter, repaid: settled.repaid };
  } catch (err: any) {
    // Money moved at the provider but settlement failed (W38/PAY-6): the
    // claim is KEPT so the charge is never re-sent, a durable
    // 'settlement_failed' marker row is persisted for the
    // reconcilePendingPotCharges retry sweep (verify-first), and a CRITICAL
    // observability event surfaces the gap immediately.
    console.error("[payOverTime] settlement failed after successful charge:", err?.message);
    captureException(err, {
      service: "payOverTime",
      operation: "captureInstallmentSettlement",
      tenantId: plan.tenantId,
      severity: "critical",
      extra: { planId: plan.id, loanId: loan.id, reference, amountCents, seq: entry.seq },
    });
    await persistPotCharge(db, {
      tenantId: plan.tenantId,
      planId: plan.id,
      loanId: loan.id,
      mandateId: mandate.id,
      provider: charge.provider ?? "unknown",
      kind: "installment",
      seq: entry.seq,
      reference,
      amountCents,
      currency: plan.currency ?? "NGN",
      status: "settlement_failed",
      providerStatus: "success",
      rawResponse: { status: "success", settlement: "failed", error: err?.message ?? "unknown" },
    }, now);
    return { ok: false, reason: "settlement_failed", reference, error: err?.message };
  }
}

async function markEntryOverdue(db: Db, plan: InstallmentPlan, entry: ScheduleEntry, now: Date): Promise<void> {
  const [fresh] = await db.select().from(installmentPlans).where(eq(installmentPlans.id, plan.id)).limit(1);
  if (!fresh) return;
  const schedule = ((fresh.schedule as ScheduleEntry[] | null) ?? []).map((e) =>
    e.seq === entry.seq && e.status !== "paid" ? { ...e, status: "overdue" as const } : e);
  await db.update(installmentPlans).set({ schedule, updatedAt: now }).where(eq(installmentPlans.id, plan.id));
}

/**
 * Cron sweep (=== W32 installment due ===): capture every due/overdue
 * installment whose due date has passed, then sync defaults — a loan past
 * dueAt + DEFAULT_GRACE_DAYS with outstanding > 0 flips to 'defaulted'
 * (microLoans late/default handling) and the plan follows honestly.
 * Append-only and safe to run repeatedly.
 */
export async function runInstallmentCaptureSweep(
  db: Db,
  opts: { now?: Date } = {},
): Promise<InstallmentSweepResult> {
  const now = opts.now ?? new Date();
  const result: InstallmentSweepResult = {
    plansScanned: 0, captured: 0, capturedCents: 0, overdue: 0, dunned: 0,
    plansRepaid: 0, plansDefaulted: 0, skippedDuplicate: 0, manualSettled: 0,
  };
  // === W45 money-ledger === PAY-20: settle completed manual payment-link
  // intents first (merchant paid off-rail after a mandate revocation).
  result.manualSettled = (await settlePaidPotManualIntents(db, now).catch((e: any) => {
    console.warn("[payOverTime] manual-intent settlement failed:", e?.message);
    return { settled: 0 };
  })).settled;
  // NOTE: 'paused' plans (mandate revoked, PAY-20) are intentionally NOT
  // selected — auto-capture AND dunning stop until re-link/admin action.
  const plans = await db.select().from(installmentPlans)
    .where(inArray(installmentPlans.status, ["active", "defaulted"]));
  result.plansScanned = plans.length;

  for (const plan of plans) {
    const schedule = (plan.schedule as ScheduleEntry[] | null) ?? [];
    for (const entry of schedule) {
      if (entry.status === "paid") continue;
      if (new Date(entry.dueAt).getTime() > now.getTime()) continue;
      const outcome = await captureInstallment(db, plan, entry, now);
      if (outcome.ok) {
        result.captured += 1;
        result.capturedCents += entry.amountCents;
        if (outcome.repaid) {
          result.plansRepaid += 1;
          break; // plan terminal — stop iterating its schedule
        }
      } else if (outcome.reason === "duplicate") {
        result.skippedDuplicate += 1;
      } else {
        result.overdue += 1;
        result.dunned += 1;
      }
    }

    // Default sync (microLoans late/default semantics).
    // W38 merger fix-forward: plans without a loan (nullable loan_id, e.g.
    // forecast fixtures) have no default to sync — skip instead of querying
    // with an invalid empty uuid (which 500'd the whole cron tick).
    if (!plan.loanId) continue;
    const [loan] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId)).limit(1);
    if (!loan) continue;
    if (
      loan.status === "active" && loan.dueAt &&
      now.getTime() > loan.dueAt.getTime() + DEFAULT_GRACE_DAYS * 24 * 3600 * 1000 &&
      loan.outstandingCents > 0
    ) {
      const [flipped] = await db.update(merchantLoans)
        .set({ status: "defaulted", defaultedAt: now, updatedAt: now })
        .where(and(eq(merchantLoans.id, loan.id), eq(merchantLoans.status, "active")))
        .returning();
      if (flipped) {
        await db.update(installmentPlans)
          .set({ status: "defaulted", updatedAt: now })
          .where(and(eq(installmentPlans.id, plan.id), eq(installmentPlans.status, "active")));
        await sendPotDunning(db, plan.tenantId,
          `⚠️ Your pay-over-time plan (${plan.installments} installments, ₦${naira(loan.outstandingCents)} outstanding) is now in DEFAULT. Please settle immediately to protect your credit standing. Your vendor was paid in full at origination.`);
        result.plansDefaulted += 1;
      }
    } else if (loan.status === "defaulted") {
      await db.update(installmentPlans)
        .set({ status: "defaulted", updatedAt: now })
        .where(and(eq(installmentPlans.id, plan.id), eq(installmentPlans.status, "active")));
    }
  }
  return result;
}

// ── Early settle ────────────────────────────────────────────────────────────

export interface EarlySettleResult {
  ok: true;
  planId: string;
  status: "repaid";
  settleCents: number;
  feePolicy: "full_fee" | "prorated";
  waivedFeeCents: number;
  reference: string;
  message: string;
}

/**
 * Repay the remaining plan balance early in a SINGLE mandate charge. Fee
 * policy (documented at the module header): full fee by default; waived
 * future-fee slices only when escrow_config.pay_over_time_prorate_early_fee
 * is enabled. Integer math — the settle amount is derived from the stored
 * per-entry principal/fee slices, never re-floated.
 */
export async function settlePlanEarly(
  db: Db,
  opts: { tenantId: string; planId: string; now?: Date },
): Promise<EarlySettleResult> {
  const now = opts.now ?? new Date();
  const [plan] = await db.select().from(installmentPlans)
    .where(and(eq(installmentPlans.id, opts.planId), eq(installmentPlans.tenantId, opts.tenantId)));
  if (!plan) throw Object.assign(new Error("Installment plan not found"), { code: "NOT_FOUND" });
  // === W45 money-ledger === PAY-20: paused plans (mandate revoked) settle
  // manually too — 'paused' only stops AUTO-capture, never repayment.
  if (plan.status !== "active" && plan.status !== "defaulted" && plan.status !== "paused") {
    throw Object.assign(new Error(`Plan is ${plan.status} — nothing to settle`), { code: "CONFLICT" });
  }
  const schedule = (plan.schedule as ScheduleEntry[] | null) ?? [];
  const cfg = await getPayOverTimeConfig(db);
  const settleCents = earlySettleAmountCents(schedule, { prorateEarlyFee: cfg.prorateEarlyFee, now });
  if (settleCents <= 0) {
    throw Object.assign(new Error("Plan has no outstanding installments"), { code: "CONFLICT" });
  }
  const remainingFee = schedule.filter((e) => e.status !== "paid").reduce((a, e) => a + e.feeCents, 0);
  const chargedFee = schedule
    .filter((e) => e.status !== "paid" && !(cfg.prorateEarlyFee && new Date(e.dueAt).getTime() > now.getTime()))
    .reduce((a, e) => a + e.feeCents, 0);
  const waivedFeeCents = remainingFee - chargedFee;

  const mandate = await findActiveMandate(db, plan.tenantId);
  if (!mandate) {
    throw Object.assign(new Error("No active payment mandate — link a mandate to settle early"), { code: "BAD_REQUEST" });
  }
  const reference = potSettleRef(plan.id);
  const claim = await claimWebhookEvent(db, { id: reference, tenantId: plan.tenantId, type: "pot_settle" });
  if (claim === "duplicate") {
    // W38/PAY-5 verify-first: a previous attempt holds the claim. Consult the
    // durable pot_charges row + the provider's READ-ONLY status before
    // concluding — never stuck forever, never a blind double-charge:
    //   success → the charge confirmed; settle NOW (exactly-once via the
    //             repayment-reference unique index + claim-first flip) and
    //             return the normal settled result.
    //   failed  → definitive failure ("abandon settle"): flip the durable
    //             row, RELEASE the claim, and tell the caller to retry.
    //   pending/unknown → still genuinely in flight; honest CONFLICT, the
    //             reconciler settles on confirmation.
    const existing = await getPotChargeByRef(db, reference);
    const probeProvider = existing?.provider ?? mandate.provider;
    const probe = await probePotChargeStatus(plan.tenantId, probeProvider, reference);
    if (probe.status === "success") {
      const settled = await applyEarlySettleTx(db, plan, reference, now);
      await drainPaymentOutboxBestEffort(db); // PAY-18 post-commit drain
      if (existing) {
        await flipPotChargeStatus(db, existing.id, ["pending", "settlement_failed"], "success", "success", now);
      }
      return {
        ok: true,
        planId: plan.id,
        status: "repaid",
        settleCents: settled.settleCents,
        feePolicy: settled.feePolicy,
        waivedFeeCents: settled.waivedFeeCents,
        reference,
        message: settled.alreadyRepaid
          ? "Plan already settled (verified at provider)"
          : `Plan settled early · ₦${naira(settled.settleCents)} charged (verified after in-flight charge)` +
            (settled.waivedFeeCents > 0 ? ` (₦${naira(settled.waivedFeeCents)} future fee waived)` : " (full fee — earned at origination)"),
      };
    }
    if (probe.status === "failed") {
      if (existing) {
        await flipPotChargeStatus(db, existing.id, ["pending", "settlement_failed"], "failed", "failed", now);
      }
      await releasePotClaim(db, reference);
      throw Object.assign(
        new Error("Previous early-settlement charge failed at the provider — please retry the settlement"),
        { code: "CONFLICT" },
      );
    }
    throw Object.assign(
      new Error("Early settlement already in flight — the plan settles automatically when the provider confirms"),
      { code: "CONFLICT" },
    );
  }

  const { chargeOnMandate } = await import("./payments/mandates");
  const charge = await chargeOnMandate(db, {
    tenantId: plan.tenantId,
    mandateId: mandate.id,
    amountCents: settleCents,
    currency: plan.currency ?? "NGN",
    reference,
    metadata: { type: "pot_settle", planId: plan.id },
  });
  if (!charge.ok || charge.status === "failed") {
    await releasePotClaim(db, reference);
    throw Object.assign(new Error(`Early settlement charge failed: ${charge.error ?? "charge_failed"}`), { code: "BAD_REQUEST" });
  }
  if (charge.status === "pending") {
    // W38/PAY-5: keep the claim AND persist a durable pending row — the
    // reconcilePendingPotCharges sweep settles the plan exactly once when
    // the provider confirms (or releases the claim on definitive failure).
    await persistPotCharge(db, {
      tenantId: plan.tenantId,
      planId: plan.id,
      loanId: plan.loanId ?? null,
      mandateId: mandate.id,
      provider: charge.provider ?? "unknown",
      kind: "settle",
      seq: null,
      reference,
      amountCents: settleCents,
      currency: plan.currency ?? "NGN",
      status: "pending",
      providerStatus: "pending",
      rawResponse: { status: "pending" },
    }, now);
    throw Object.assign(new Error("Early settlement charge is pending at the provider — the plan settles when it confirms"), { code: "CONFLICT" });
  }

  const settled = await applyEarlySettleTx(db, plan, reference, now);
  await drainPaymentOutboxBestEffort(db); // PAY-18 post-commit drain
  await persistPotCharge(db, {
    tenantId: plan.tenantId,
    planId: plan.id,
    loanId: plan.loanId ?? null,
    mandateId: mandate.id,
    provider: charge.provider ?? "unknown",
    kind: "settle",
    seq: null,
    reference,
    amountCents: settleCents,
    currency: plan.currency ?? "NGN",
    status: "success",
    providerStatus: "success",
    rawResponse: { status: "success" },
  }, now);

  return {
    ok: true,
    planId: plan.id,
    status: "repaid",
    settleCents: settled.settleCents,
    feePolicy: settled.feePolicy,
    waivedFeeCents: settled.waivedFeeCents,
    reference,
    message: `Plan settled early · ₦${naira(settled.settleCents)} charged` +
      (settled.waivedFeeCents > 0 ? ` (₦${naira(settled.waivedFeeCents)} future fee waived)` : " (full fee — earned at origination)"),
  };
}

/** READ-ONLY provider status probe for a PoT charge reference. */
export type PotChargeProbeStatus = "pending" | "success" | "failed" | "unknown";
async function probePotChargeStatus(tenantId: string, provider: string, reference: string): Promise<{ status: PotChargeProbeStatus }> {
  try {
    const { fetchMandateChargeStatus } = await import("./payments/mandates");
    return await fetchMandateChargeStatus(tenantId, { provider, reference });
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Settle an early-settle charge against the plan in ONE locked transaction
 * (extracted W38 so the in-flight verify-first path AND the reconciler share
 * the exact settlement semantics). Idempotent: an already-repaid plan is a
 * no-op; each entry settles via settleCapturedAmountTx whose repayment row
 * carries a unique reference (`<settleRef>:<seq>`), so a double invocation
 * can never double-settle.
 */
async function applyEarlySettleTx(
  db: Db,
  plan: InstallmentPlan,
  reference: string,
  now: Date,
): Promise<{ settleCents: number; waivedFeeCents: number; feePolicy: "full_fee" | "prorated"; alreadyRepaid: boolean }> {
  const cfg = await getPayOverTimeConfig(db);
  const out = {
    settleCents: 0,
    waivedFeeCents: 0,
    feePolicy: (cfg.prorateEarlyFee ? "prorated" : "full_fee") as "full_fee" | "prorated",
    alreadyRepaid: false,
  };
  const [loan] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId ?? "")).limit(1);
  if (!loan) throw Object.assign(new Error("Backing loan missing"), { code: "INTERNAL_SERVER_ERROR" });

  await db.transaction(async (tx: Tx) => {
    const [lockedPlan] = await tx.select().from(installmentPlans)
      .where(eq(installmentPlans.id, plan.id)).limit(1).for("update");
    if (!lockedPlan) throw new Error(`[payOverTime] plan ${plan.id} missing at early settle`);
    if (lockedPlan.status === "repaid") {
      out.alreadyRepaid = true;
      return;
    }
    const schedule = (lockedPlan.schedule as ScheduleEntry[] | null) ?? [];
    out.settleCents = earlySettleAmountCents(schedule, { prorateEarlyFee: cfg.prorateEarlyFee, now });
    const remainingFee = schedule.filter((e) => e.status !== "paid").reduce((a, e) => a + e.feeCents, 0);
    const chargedFee = schedule
      .filter((e) => e.status !== "paid" && !(cfg.prorateEarlyFee && new Date(e.dueAt).getTime() > now.getTime()))
      .reduce((a, e) => a + e.feeCents, 0);
    out.waivedFeeCents = remainingFee - chargedFee;

    // Settle every unpaid entry: principal portions restore the facility;
    // only the CHARGED fee slices post the platform-fee leg (prorate policy).
    for (const entry of schedule) {
      if (entry.status === "paid") continue;
      const futureFeeWaived = cfg.prorateEarlyFee && new Date(entry.dueAt).getTime() > now.getTime();
      const charged: ScheduleEntry = futureFeeWaived ? { ...entry, feeCents: 0 } : entry;
      await settleCapturedAmountTx(tx, lockedPlan, loan, charged, charged.amountCents, `${reference}:${entry.seq}`.slice(0, 160), now);
    }
    // Prorate policy: write off the waived future-fee remainder so the loan
    // closes exactly at zero (integer cents, GREATEST-clamped).
    if (out.waivedFeeCents > 0) {
      await tx.update(merchantLoans)
        .set({ outstandingCents: sql`GREATEST(0, ${merchantLoans.outstandingCents} - ${out.waivedFeeCents})`, updatedAt: now })
        .where(eq(merchantLoans.id, loan.id));
    }
    // Force-close when nothing is left (settleCapturedAmountTx flips status
    // only when ITS decrement zeroes the loan — the waiver path closes here).
    const [finalLoan] = await tx.select().from(merchantLoans).where(eq(merchantLoans.id, loan.id)).limit(1);
    if (finalLoan && finalLoan.outstandingCents === 0) {
      await tx.update(merchantLoans)
        .set({ status: "repaid", repaidAt: now, updatedAt: now })
        .where(and(eq(merchantLoans.id, loan.id), eq(merchantLoans.outstandingCents, 0)));
      await tx.update(installmentPlans)
        .set({ status: "repaid", updatedAt: now })
        .where(and(eq(installmentPlans.id, plan.id), inArray(installmentPlans.status, ["active", "defaulted", "paused"])));
    }
  });
  return out;
}

// ── W38/PAY-4/5/6: pending/settlement_failed pot_charges reconciler ─────────

export interface ReconcilePotChargesResult {
  checked: number;
  settled: number;
  failed: number;
  /** settlement_failed rows retried to a successful settlement. */
  retried: number;
  stillPending: number;
}

export type PotChargeStatusProbe = (args: {
  tenantId: string;
  provider: string;
  reference: string;
}) => Promise<{ status: PotChargeProbeStatus; amountCents?: number }>;

const defaultPotProbe: PotChargeStatusProbe = ({ tenantId, provider, reference }) =>
  probePotChargeStatus(tenantId, provider, reference);

/** Exactly-once check: a repayment row already carrying this reference. */
async function potRepaymentExists(db: Db, reference: string): Promise<boolean> {
  const [r] = await db.select({ id: merchantLoanRepayments.id })
    .from(merchantLoanRepayments).where(eq(merchantLoanRepayments.reference, reference)).limit(1)
    .catch(() => []);
  return !!r;
}

/**
 * Settle one confirmed pot_charges row against its plan. Returns true when
 * the money is reflected on the loan (settled now, or already settled —
 * the merchant_loan_repayments reference unique index is the backstop).
 * Never re-charges the provider; local bookkeeping only.
 */
async function settlePotChargeRow(db: Db, plan: InstallmentPlan, row: any, now: Date): Promise<boolean> {
  try {
    if (row.kind === "settle") {
      await applyEarlySettleTx(db, plan, row.reference, now);
      await drainPaymentOutboxBestEffort(db); // PAY-18 post-commit drain
      return true;
    }
    const [loan] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId ?? "")).limit(1);
    if (!loan) return false;
    const schedule = (plan.schedule as ScheduleEntry[] | null) ?? [];
    const entry = schedule.find((e) => e.seq === row.seq);
    if (!entry || entry.status === "paid") return true; // settled earlier
    await db.transaction(async (tx: Tx) =>
      settleCapturedAmountTx(tx, plan, loan, entry, Math.min(row.amountCents, entry.amountCents), row.reference, now));
    await drainPaymentOutboxBestEffort(db); // PAY-18 post-commit drain
    return true;
  } catch (err: any) {
    // Already settled via the repayment-reference unique backstop (a lost
    // race against the direct path / a previous sweep), or the settle path
    // closed the plan already.
    if (row.kind === "settle") {
      const [fresh] = await db.select().from(installmentPlans).where(eq(installmentPlans.id, plan.id)).limit(1);
      if (fresh?.status === "repaid") return true;
    } else if (await potRepaymentExists(db, row.reference)) {
      return true;
    }
    console.warn(`[payOverTime] reconcile settle failed for ${row.reference}:`, err?.message);
    return false;
  }
}

/**
 * Sweep pot_charges rows in 'pending' / 'settlement_failed' and converge
 * them via the provider's READ-ONLY fetchStatus(reference) — NEVER a blind
 * re-charge:
 *
 *   success → settle exactly once against the plan (installment entry via
 *             settleCapturedAmountTx with the SAME reference; early-settle
 *             via applyEarlySettleTx — both exactly-once by the repayment
 *             reference unique index), then claim-first flip to 'success'.
 *             A settlement refusal flips the row to 'settlement_failed' and
 *             captures a CRITICAL event — the NEXT sweep retries the
 *             settlement verify-first (PAY-6).
 *   failed  → 'pending' rows: claim-first flip to 'failed', release the
 *             exactly-once claim (a fresh capture/settle attempt may
 *             proceed), mark the installment overdue + dun. A
 *             'settlement_failed' row whose probe now says 'failed' is a
 *             money ambiguity (the charge reported success earlier) —
 *             fail-CLOSED: keep the marker and alert CRITICAL for ops.
 *   pending/unknown (incl. probe timeout/error) → leave for the next sweep.
 *
 * Never throws into the caller.
 */
export async function reconcilePendingPotCharges(
  db: Db,
  opts: { limit?: number; probe?: PotChargeStatusProbe } = {},
  now: Date = new Date(),
): Promise<ReconcilePotChargesResult> {
  const probe = opts.probe ?? defaultPotProbe;
  const result: ReconcilePotChargesResult = { checked: 0, settled: 0, failed: 0, retried: 0, stillPending: 0 };
  try {
    const rows = (await db.select().from(potCharges)
      .where(inArray(potCharges.status, ["pending", "settlement_failed"]))
      .orderBy(asc(potCharges.createdAt))
      .limit(Math.max(1, Math.min(opts.limit ?? 100, 500)))) as any[];

    for (const row of rows) {
      result.checked += 1;
      const wasSettlementFailed = row.status === "settlement_failed";
      try {
        const [plan] = await db.select().from(installmentPlans)
          .where(eq(installmentPlans.id, row.planId)).limit(1);
        if (!plan) {
          result.stillPending += 1;
          continue;
        }
        const verdict = await probe({ tenantId: row.tenantId, provider: row.provider, reference: row.reference });

        if (verdict.status === "success") {
          const settled = await settlePotChargeRow(db, plan, row, now);
          if (settled) {
            await flipPotChargeStatus(db, row.id, ["pending", "settlement_failed"], "success", "success", now);
            if (wasSettlementFailed) result.retried += 1;
            else result.settled += 1;
          } else {
            // Money confirmed at the provider but settlement refused —
            // durable marker + CRITICAL capture; the sweep retries.
            if (!wasSettlementFailed) {
              await flipPotChargeStatus(db, row.id, ["pending"], "settlement_failed", "success", now);
            }
            captureException(new Error(`reconcile: settlement refused for confirmed PoT charge ${row.reference}`), {
              service: "payOverTime",
              operation: "reconcilePendingPotCharges",
              tenantId: row.tenantId,
              severity: "critical",
              extra: { planId: row.planId, reference: row.reference, amountCents: row.amountCents, kind: row.kind },
            });
            result.stillPending += 1;
          }
        } else if (verdict.status === "failed") {
          if (wasSettlementFailed) {
            // The charge reported SUCCESS when attempted; the provider now
            // reports failure. Money is ambiguous — fail CLOSED: keep the
            // settlement_failed marker and alert CRITICAL for ops review.
            captureException(new Error(`reconcile: provider now reports failed for previously-successful PoT charge ${row.reference}`), {
              service: "payOverTime",
              operation: "reconcilePendingPotCharges",
              tenantId: row.tenantId,
              severity: "critical",
              extra: { planId: row.planId, reference: row.reference, amountCents: row.amountCents, kind: row.kind },
            });
            result.stillPending += 1;
          } else {
            const flipped = await flipPotChargeStatus(db, row.id, ["pending"], "failed", "failed", now);
            if (flipped) {
              await releasePotClaim(db, row.reference);
              const schedule = (plan.schedule as ScheduleEntry[] | null) ?? [];
              if (row.kind === "installment") {
                const entry = schedule.find((e) => e.seq === row.seq);
                if (entry && entry.status !== "paid") {
                  await markEntryOverdue(db, plan, entry, now);
                  await sendPotDunning(db, plan.tenantId,
                    `⚠️ We couldn't collect installment ${row.seq} of your pay-over-time plan (₦${naira(row.amountCents)} — the pending charge failed at the provider). We'll retry on the next collection run, or you can settle early from the dashboard. Your vendor was already paid in full.`);
                }
              } else {
                await sendPotDunning(db, plan.tenantId,
                  `⚠️ Your early-settlement charge of ₦${naira(row.amountCents)} failed at the provider. No money moved — you can retry the settlement from the dashboard.`);
              }
            }
            result.failed += 1;
          }
        } else {
          // 'pending' / 'unknown' — next sweep re-probes (READ-ONLY only).
          result.stillPending += 1;
        }
      } catch (err: any) {
        result.stillPending += 1;
        console.warn(`[payOverTime] reconcile row ${row.id} failed:`, err?.message);
      }
    }
  } catch (err: any) {
    captureException(err, {
      service: "payOverTime",
      operation: "reconcilePendingPotCharges",
      severity: "error",
    });
  }
  return result;
}

/** Convenience wrapper for cron/sweep invokers (own db handle). */
export async function reconcilePendingPotChargesGlobal(
  opts: { limit?: number; probe?: PotChargeStatusProbe; now?: Date } = {},
): Promise<ReconcilePotChargesResult> {
  const db = await getDb();
  if (!db) throw new Error("[payOverTime] database unavailable");
  return reconcilePendingPotCharges(db, opts, opts.now ?? new Date());
}

// === W45 money-ledger === PAY-20: mandate revocation lifecycle ──────────────
// Revoke → pause auto-capture + re-link CTA (both channels) + manual
// payment-link fallback + admin cancel/restructure. Dunning ENDS while paused
// (the capture sweep only selects active/defaulted plans) — no infinite
// dunning against a mandate the merchant killed.

/** Both-channels merchant notice for PoT lifecycle events (parity category pot_plan). */
export async function notifyPotMerchant(db: Db, tenantId: string, text: string, paymentUrl?: string | null): Promise<void> {
  try {
    const [t] = await db.select({ settings: tenants.settings }).from(tenants)
      .where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
    const phone = (t?.settings as any)?.adminPhone ?? (t?.settings as any)?.whatsapp?.adminPhone ?? null;
    if (!phone) {
      console.info(`[payOverTime] no admin phone for tenant ${tenantId} — pot notice skipped`);
      return;
    }
    const { notifyCustomer } = await import("./channelParity");
    const routed = await notifyCustomer(tenantId, phone, "pot_plan", {
      text: paymentUrl ? `${text}\n\nPay here: ${paymentUrl}` : text,
      paymentUrl: paymentUrl ?? undefined,
      notifType: "pot_plan",
    } as any).catch(() => ({ handled: false }) as any);
    if (routed?.handled) return; // telegram-linked admin got it via channelSender
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(tenantId, phone, paymentUrl ? `${text}\n\nPay here: ${paymentUrl}` : text, { notifType: "pot_plan" })
      .catch((e: any) => console.warn("[payOverTime] pot notice WA failed:", e?.message));
  } catch (err: any) {
    console.warn("[payOverTime] notifyPotMerchant failed:", err?.message);
  }
}

/**
 * PAY-20 manual payment-link fallback: mint (or reuse) a hosted-checkout
 * payment intent for the plan's current early-settle amount through the
 * EXISTING initiateWithFallback chain — never a fake URL. Idempotency key
 * `pot-manual:<planId>`: a second call returns the still-open link. The
 * completed intent is settled exactly-once by settlePaidPotManualIntents
 * (sweep) — paymentConfirm.ts stays PINNED (adjacent seam only).
 */
export interface PotManualLinkResult {
  ok: boolean;
  paymentUrl: string | null;
  reference?: string;
  amountCents?: number;
  currency?: string;
  error?: string;
}

export async function createPotManualPaymentLink(
  db: Db,
  opts: { tenantId: string; planId: string; now?: Date },
): Promise<PotManualLinkResult> {
  const now = opts.now ?? new Date();
  try {
    const [plan] = await db.select().from(installmentPlans)
      .where(and(eq(installmentPlans.id, opts.planId), eq(installmentPlans.tenantId, opts.tenantId)));
    if (!plan) return { ok: false, paymentUrl: null, error: "plan_not_found" };
    if (!["active", "defaulted", "paused"].includes(plan.status)) {
      return { ok: false, paymentUrl: null, error: `plan_${plan.status}` };
    }
    const cfg = await getPayOverTimeConfig(db);
    const schedule = (plan.schedule as ScheduleEntry[] | null) ?? [];
    const amountCents = earlySettleAmountCents(schedule, { prorateEarlyFee: cfg.prorateEarlyFee, now });
    if (amountCents <= 0) return { ok: false, paymentUrl: null, error: "nothing_outstanding" };
    const currency = (plan.currency ?? "NGN").toUpperCase();
    const idemKey = `pot-manual:${plan.id}`.slice(0, 128);

    const { paymentIntents } = await import("../../drizzle/schema");
    const [existing] = await db.select().from(paymentIntents)
      .where(eq(paymentIntents.idempotencyKey, idemKey)).limit(1).catch(() => [] as any[]);
    if (existing && !["completed", "failed"].includes(existing.status)) {
      return {
        ok: true,
        paymentUrl: (existing.metadata as any)?.paymentUrl ?? null,
        reference: existing.providerPaymentId ?? undefined,
        amountCents: Math.round(Number(existing.amount) * 100),
        currency: existing.currency,
      };
    }

    const intentId = crypto.randomUUID();
    const reference = `POTM-${now.getTime().toString(36).toUpperCase()}-${intentId.slice(0, 8).toUpperCase()}`;
    await db.insert(paymentIntents).values({
      id: intentId,
      tenantId: opts.tenantId,
      // Non-order reference: paymentConfirm treats unknown orderIds as
      // non-order references (no escrow/order fan-out) — planId rides here.
      orderId: plan.id,
      customerId: opts.tenantId,
      amount: (amountCents / 100).toFixed(2),
      currency,
      provider: "paystack",
      providerPaymentId: reference,
      idempotencyKey: idemKey,
      status: "pending",
      metadata: { kind: "pot_manual_settle", planId: plan.id, tenantId: opts.tenantId },
      createdAt: now,
      updatedAt: now,
    });
    let paymentUrl: string | null = null;
    try {
      const { initiateWithFallback } = await import("./payments/initiateWithFallback");
      const { ENV } = await import("../_core/env");
      const fallback = await initiateWithFallback(opts.tenantId, {
        tenantId: opts.tenantId,
        amountCents,
        currency,
        reference,
        metadata: { payment_intent_id: intentId, tenant_id: opts.tenantId, kind: "pot_manual_settle", planId: plan.id },
        customer: { phone: opts.tenantId },
        callbackUrl: `${ENV.appUrl}/vendor-bills`,
      });
      paymentUrl = fallback.result.authorizationUrl ?? null;
      await db.update(paymentIntents).set({
        status: "initiated",
        metadata: { kind: "pot_manual_settle", planId: plan.id, tenantId: opts.tenantId, paymentUrl, servedProvider: fallback.providerId },
        updatedAt: new Date(),
      }).where(eq(paymentIntents.id, intentId));
    } catch (e: any) {
      await db.update(paymentIntents).set({
        status: "failed",
        failureReason: `provider_init: ${String(e?.message ?? e).slice(0, 300)}`,
        updatedAt: new Date(),
      }).where(eq(paymentIntents.id, intentId)).catch(() => {});
      return { ok: false, paymentUrl: null, error: `provider_init: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    return { ok: true, paymentUrl, reference, amountCents, currency };
  } catch (err: any) {
    console.error("[payOverTime] createPotManualPaymentLink failed:", err?.message);
    return { ok: false, paymentUrl: null, error: err?.message ?? "manual_link_error" };
  }
}

/**
 * Sweep seam (PINNED paymentConfirm stays untouched): completed
 * pot_manual_settle intents settle their plan exactly once. Verify-first:
 * the intent must be 'completed' (money confirmed by the pinned webhook
 * pipeline) and the paid amount must cover the CURRENT early-settle amount —
 * an underpayment is never applied blind; it pages ops for a refund/manual
 * fix instead.
 */
export async function settlePaidPotManualIntents(db: Db, now: Date = new Date()): Promise<{ settled: number }> {
  const { paymentIntents } = await import("../../drizzle/schema");
  const rows = (await db.select().from(paymentIntents)
    .where(and(
      eq(paymentIntents.status, "completed"),
      sql`${paymentIntents.metadata}->>'kind' = 'pot_manual_settle'`,
      sql`${paymentIntents.metadata}->>'potSettled' IS NULL`,
    ))
    .limit(100)
    .catch(() => [] as any[])) as any[];
  let settled = 0;
  for (const intent of rows) {
    try {
      // Claim-first: mark potSettled before settling (replay no-op).
      const [claim] = await db.update(paymentIntents)
        .set({ metadata: sql`COALESCE(metadata, '{}'::jsonb) || '{"potSettled": true}'::jsonb`, updatedAt: now })
        .where(and(eq(paymentIntents.id, intent.id), sql`${paymentIntents.metadata}->>'potSettled' IS NULL`))
        .returning({ id: paymentIntents.id });
      if (!claim) continue;
      const planId = intent.metadata?.planId;
      const [plan] = await db.select().from(installmentPlans).where(eq(installmentPlans.id, planId)).limit(1);
      if (!plan || plan.status === "repaid" || plan.status === "cancelled") continue;
      const cfg = await getPayOverTimeConfig(db);
      const schedule = (plan.schedule as ScheduleEntry[] | null) ?? [];
      const dueCents = earlySettleAmountCents(schedule, { prorateEarlyFee: cfg.prorateEarlyFee, now });
      const paidCents = Math.round(Number(intent.amount) * 100);
      if (paidCents < dueCents) {
        captureException(new Error(`pot manual settle underpaid: intent ${intent.id} paid ${paidCents} < ${dueCents} due`), {
          service: "payOverTime", operation: "settlePaidPotManualIntents", tenantId: intent.tenantId,
          severity: "critical", extra: { intentId: intent.id, planId, paidCents, dueCents },
        });
        continue; // claimed but not settled — ops resolves (refund/top-up)
      }
      await applyEarlySettleTx(db, plan, `potmanual:${intent.id}`.slice(0, 128), now);
      await drainPaymentOutboxBestEffort(db); // PAY-18 post-commit drain
      settled += 1;
      await notifyPotMerchant(db, intent.tenantId,
        `✅ Manual payment received — your pay-over-time plan is settled in full. Thank you!`);
    } catch (err: any) {
      console.warn(`[payOverTime] manual intent ${intent.id} settle failed:`, err?.message);
    }
  }
  return { settled };
}

/**
 * PAY-20 entry point (called from payments/mandates.revokeMandate after the
 * local flip commits): pause auto-capture on every active/defaulted plan of
 * the tenant (guarded flip to 'paused'), then notify the merchant on BOTH
 * channels with a re-link CTA + a manual payment-link fallback. Never throws
 * (mandates.ts fail-closed contract).
 */
export async function onMandateRevoked(
  db: Db,
  args: { tenantId: string; mandateId: string; mandateRef?: string | null },
): Promise<{ pausedPlans: number }> {
  try {
    const now = new Date();
    const paused = await db.update(installmentPlans)
      .set({ status: "paused", updatedAt: now })
      .where(and(
        eq(installmentPlans.tenantId, args.tenantId),
        inArray(installmentPlans.status, ["active", "defaulted"]),
      ))
      .returning({ id: installmentPlans.id });
    for (const p of paused) {
      const link = await createPotManualPaymentLink(db, { tenantId: args.tenantId, planId: p.id, now });
      await notifyPotMerchant(db, args.tenantId,
        `⚠️ Your payment mandate was revoked, so automatic collection for your pay-over-time plan is PAUSED — we won't keep retrying it. ` +
        `To resume auto-collection, link a new mandate from the dashboard. You can also settle the plan manually right now:`,
        link.paymentUrl);
    }
    return { pausedPlans: paused.length };
  } catch (err: any) {
    console.error("[payOverTime] onMandateRevoked failed:", err?.message);
    captureException(err, {
      service: "payOverTime", operation: "onMandateRevoked", tenantId: args.tenantId,
      severity: "error", extra: { mandateId: args.mandateId },
    });
    return { pausedPlans: 0 };
  }
}

/**
 * PAY-20 re-link CTA follow-through (called from confirmMandateTx when a new
 * mandate activates): paused plans resume auto-capture. Guarded flip; the
 * next due sweep captures per the mandate rules.
 */
export async function resumePotPlansOnMandateLink(db: Db, tenantId: string): Promise<{ resumedPlans: number }> {
  const now = new Date();
  const resumed = await db.update(installmentPlans)
    .set({ status: "active", updatedAt: now })
    .where(and(eq(installmentPlans.tenantId, tenantId), eq(installmentPlans.status, "paused")))
    .returning({ id: installmentPlans.id });
  if (resumed.length > 0) {
    await notifyPotMerchant(db, tenantId,
      `✅ New payment mandate linked — automatic collection has RESUMED for ${resumed.length} pay-over-time plan(s).`);
  }
  return { resumedPlans: resumed.length };
}

/**
 * PAY-20 admin cancel: terminal write-off of a plan (facility absorbs the
 * remaining exposure honestly — outstanding recorded as written off in plan
 * metadata, loan closed 'cancelled', no more captures/dunning ever). Audited.
 */
export async function adminCancelPlan(
  db: Db,
  opts: { tenantId: string; planId: string; actor: string; reason: string },
): Promise<{ ok: true; planId: string; writeOffCents: number }> {
  const now = new Date();
  const result = await db.transaction(async (tx: Tx) => {
    const [plan] = await tx.select().from(installmentPlans)
      .where(and(eq(installmentPlans.id, opts.planId), eq(installmentPlans.tenantId, opts.tenantId)))
      .for("update");
    if (!plan) throw Object.assign(new Error("Installment plan not found"), { code: "NOT_FOUND" });
    if (!["active", "defaulted", "paused"].includes(plan.status)) {
      throw Object.assign(new Error(`Plan is ${plan.status} — cannot cancel`), { code: "CONFLICT" });
    }
    const [loan] = await tx.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId ?? "")).limit(1).for("update");
    const writeOffCents = loan?.outstandingCents ?? 0;
    await tx.update(installmentPlans)
      .set({
        status: "cancelled",
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ cancelledBy: opts.actor, cancelReason: opts.reason.slice(0, 300), writeOffCents, cancelledAt: now.toISOString() })}::jsonb`,
        updatedAt: now,
      })
      .where(eq(installmentPlans.id, plan.id));
    if (loan) {
      await tx.update(merchantLoans)
        .set({ status: "cancelled", outstandingCents: 0, updatedAt: now })
        .where(and(eq(merchantLoans.id, loan.id), inArray(merchantLoans.status, ["active", "defaulted"])));
    }
    if (plan.vendorBillId) {
      const { appendBillEvent } = await import("./vendorBills");
      await appendBillEvent(tx, plan.vendorBillId, "payment_recorded", opts.actor, {
        financing: "pay_over_time", planId: plan.id, planEvent: "cancelled",
        writeOffCents, reason: opts.reason.slice(0, 300),
      }).catch((e: any) => console.warn("[payOverTime] cancel bill-event failed:", e?.message));
    }
    return { writeOffCents };
  });
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: opts.tenantId, actorId: opts.actor, action: "pay_over_time.cancel_plan",
      entityType: "installment_plan", entityId: opts.planId,
      summary: `plan=${opts.planId} writeOff=${result.writeOffCents} reason=${opts.reason.slice(0, 120)}`,
    } as any);
  } catch (e: any) {
    console.warn("[payOverTime] cancel audit write failed:", e?.message);
  }
  await notifyPotMerchant(db, opts.tenantId,
    `Your pay-over-time plan was cancelled by support (written off: ₦${naira(result.writeOffCents)}). Reason: ${opts.reason.slice(0, 200)}. No further collection attempts will be made.`);
  return { ok: true, planId: opts.planId, writeOffCents: result.writeOffCents };
}

/**
 * PAY-20 admin restructure: re-split the plan's REMAINING unpaid principal +
 * fee over a new installment count starting now (no new fee is minted;
 * integer cents, rounding remainder rides the last installment). The plan
 * resumes 'active' when a mandate exists, else stays honestly 'paused'.
 * Audited + merchant notified on both channels.
 */
export async function adminRestructurePlan(
  db: Db,
  opts: { tenantId: string; planId: string; installments: PotInstallments; actor: string; note?: string },
): Promise<{ ok: true; planId: string; status: string; schedule: ScheduleEntry[] }> {
  const now = new Date();
  if (!POT_INSTALLMENT_CHOICES.includes(opts.installments)) {
    throw Object.assign(new Error(`installments must be one of ${POT_INSTALLMENT_CHOICES.join("/")}`), { code: "BAD_REQUEST" });
  }
  const out = await db.transaction(async (tx: Tx) => {
    const [plan] = await tx.select().from(installmentPlans)
      .where(and(eq(installmentPlans.id, opts.planId), eq(installmentPlans.tenantId, opts.tenantId)))
      .for("update");
    if (!plan) throw Object.assign(new Error("Installment plan not found"), { code: "NOT_FOUND" });
    if (!["active", "defaulted", "paused"].includes(plan.status)) {
      throw Object.assign(new Error(`Plan is ${plan.status} — cannot restructure`), { code: "CONFLICT" });
    }
    const old = (plan.schedule as ScheduleEntry[] | null) ?? [];
    const remPrincipal = old.filter((e) => e.status !== "paid").reduce((a, e) => a + e.principalCents, 0);
    const remFee = old.filter((e) => e.status !== "paid").reduce((a, e) => a + e.feeCents, 0);
    const paid = old.filter((e) => e.status === "paid");
    if (remPrincipal + remFee <= 0) {
      throw Object.assign(new Error("Plan has no outstanding installments"), { code: "CONFLICT" });
    }
    const n = opts.installments;
    const perTotal = Math.floor((remPrincipal + remFee) / n);
    const perPrincipal = Math.floor(remPrincipal / n);
    const perFee = Math.floor(remFee / n);
    const fresh: ScheduleEntry[] = [];
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      fresh.push({
        seq: paid.length + i + 1,
        dueAt: new Date(now.getTime() + (i + 1) * INSTALLMENT_PERIOD_DAYS * 24 * 3600 * 1000).toISOString(),
        amountCents: last ? remPrincipal + remFee - perTotal * (n - 1) : perTotal,
        principalCents: last ? remPrincipal - perPrincipal * (n - 1) : perPrincipal,
        feeCents: last ? remFee - perFee * (n - 1) : perFee,
        status: "due",
        paidAt: null,
      });
    }
    const schedule = [...paid, ...fresh];
    const mandate = await findActiveMandate(tx, opts.tenantId);
    const nextStatus = mandate ? "active" : "paused";
    await tx.update(installmentPlans)
      .set({
        schedule,
        installments: n,
        perInstallmentCents: perTotal,
        status: nextStatus,
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ restructuredBy: opts.actor, restructuredAt: now.toISOString(), note: (opts.note ?? "").slice(0, 300) })}::jsonb`,
        updatedAt: now,
      })
      .where(eq(installmentPlans.id, plan.id));
    if (plan.loanId) {
      await tx.update(merchantLoans)
        .set({ dueAt: new Date(fresh[fresh.length - 1].dueAt), status: "active", updatedAt: now })
        .where(and(eq(merchantLoans.id, plan.loanId), inArray(merchantLoans.status, ["active", "defaulted"])));
    }
    return { schedule, status: nextStatus };
  });
  try {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      tenantId: opts.tenantId, actorId: opts.actor, action: "pay_over_time.restructure_plan",
      entityType: "installment_plan", entityId: opts.planId,
      summary: `plan=${opts.planId} installments=${opts.installments} status=${out.status}`,
    } as any);
  } catch (e: any) {
    console.warn("[payOverTime] restructure audit write failed:", e?.message);
  }
  await notifyPotMerchant(db, opts.tenantId,
    `Your pay-over-time plan was restructured into ${opts.installments} installments${out.status === "paused" ? " — link a payment mandate to resume automatic collection" : " — automatic collection has resumed"}.`);
  return { ok: true, planId: opts.planId, status: out.status, schedule: out.schedule };
}
// === END W45 money-ledger ===

// ── Read helpers ────────────────────────────────────────────────────────────

export async function listInstallmentPlans(db: Db, tenantId: string): Promise<InstallmentPlan[]> {
  return db.select().from(installmentPlans)
    .where(eq(installmentPlans.tenantId, tenantId))
    .orderBy(desc(installmentPlans.createdAt));
}

export async function getInstallmentPlan(db: Db, tenantId: string, planId: string): Promise<InstallmentPlan | null> {
  const [plan] = await db.select().from(installmentPlans)
    .where(and(eq(installmentPlans.id, planId), eq(installmentPlans.tenantId, tenantId))).limit(1);
  return plan ?? null;
}

/** Convenience wrappers used by the cron route (own db handle). */
export async function runInstallmentCaptureSweepGlobal(now?: Date): Promise<InstallmentSweepResult> {
  const db = await getDb();
  if (!db) throw new Error("[payOverTime] database unavailable");
  return runInstallmentCaptureSweep(db, { now });
}
