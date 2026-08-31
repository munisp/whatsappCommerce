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
  vendorBills,
  type InstallmentPlan,
  type MerchantLoan,
} from "../../drizzle/schema";
import { getMerchantScore } from "./creditScore";
import { getDb } from "../db";
import { ledgerBridgeRequest, LedgerBridgeError } from "./ledgerBridge";
import { claimWebhookEvent } from "./webhookDedupe";
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

async function postLedgerTransfer(
  body: {
    debit_account_id: string;
    credit_account_id: string;
    amount: number;
    idempotency_key: string;
  },
): Promise<void> {
  try {
    await ledgerBridgeRequest("/transfer", "POST", { ...body, ledger: 1, code: 1 });
  } catch (err: any) {
    // 400/409 under the same idempotency key = already posted → no-op.
    if (err instanceof LedgerBridgeError && err.status != null && [400, 409].includes(err.status)) return;
    throw err;
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
    // TigerBeetle BEFORE the bill flip: a bridge failure throws and rolls
    // the whole origination back — no unbacked "paid" bill.
    await postLedgerTransfer({
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
  // portion (the funding becomes lendable again) and post both TigerBeetle
  // transfers — principal back to the facility account, fee to platform
  // fees (mirrors the escrow fee leg, integer cents).
  const funding = await tx.select().from(merchantLoanFunding)
    .where(eq(merchantLoanFunding.loanId, lockedLoan.id)).limit(1);
  const facilityId = funding[0]?.facilityId ?? null;
  if (facilityId && entry.principalCents > 0) {
    await tx.update(creditFacilities)
      .set({ commitmentCents: sql`${creditFacilities.commitmentCents} + ${entry.principalCents}`, updatedAt: now })
      .where(eq(creditFacilities.id, facilityId));
    await postLedgerTransfer({
      debit_account_id: `mandate-clearing:${lockedLoan.tenantId}`,
      credit_account_id: `credit-facility:${facilityId}`,
      amount: entry.principalCents,
      idempotency_key: `potrepay:${plan.id}:${entry.seq}`.slice(0, 64),
    });
  }
  if (entry.feeCents > 0) {
    await postLedgerTransfer({
      debit_account_id: `mandate-clearing:${lockedLoan.tenantId}`,
      credit_account_id: "platform-fees:NGN",
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
    // entry 'due' — the reconciler/next sweep converges via the claim's
    // duplicate verdict. Never settled early, never re-charged.
    return { ok: false, reason: "duplicate", reference, error: "charge_pending" };
  }

  try {
    const settled = await db.transaction(async (tx: Tx) =>
      settleCapturedAmountTx(tx, plan, loan, entry, amountCents, reference, now));
    return { ok: true, reference, outstandingAfter: settled.outstandingAfter, repaid: settled.repaid };
  } catch (err: any) {
    // Money moved at the provider but settlement failed: the claim is KEPT
    // so the charge is never re-sent; the entry stays unpaid for ops/retry.
    console.error("[payOverTime] settlement failed after successful charge:", err?.message);
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
    plansRepaid: 0, plansDefaulted: 0, skippedDuplicate: 0,
  };
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
    const [loan] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId ?? "")).limit(1);
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
  if (plan.status !== "active" && plan.status !== "defaulted") {
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
    throw Object.assign(new Error("Early settlement already in flight or completed for this plan"), { code: "CONFLICT" });
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
    throw Object.assign(new Error("Early settlement charge is pending at the provider — the plan settles when it confirms"), { code: "CONFLICT" });
  }

  const [loan] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, plan.loanId ?? "")).limit(1);
  if (!loan) throw Object.assign(new Error("Backing loan missing"), { code: "INTERNAL_SERVER_ERROR" });

  await db.transaction(async (tx: Tx) => {
    // Settle every unpaid entry: principal portions restore the facility;
    // only the CHARGED fee slices post the platform-fee leg (prorate policy).
    for (const entry of schedule) {
      if (entry.status === "paid") continue;
      const futureFeeWaived = cfg.prorateEarlyFee && new Date(entry.dueAt).getTime() > now.getTime();
      const charged: ScheduleEntry = futureFeeWaived ? { ...entry, feeCents: 0 } : entry;
      await settleCapturedAmountTx(tx, plan, loan, charged, charged.amountCents, `${reference}:${entry.seq}`.slice(0, 160), now);
    }
    // Prorate policy: write off the waived future-fee remainder so the loan
    // closes exactly at zero (integer cents, GREATEST-clamped).
    if (waivedFeeCents > 0) {
      await tx.update(merchantLoans)
        .set({ outstandingCents: sql`GREATEST(0, ${merchantLoans.outstandingCents} - ${waivedFeeCents})`, updatedAt: now })
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
        .where(and(eq(installmentPlans.id, plan.id), inArray(installmentPlans.status, ["active", "defaulted"])));
    }
  });

  return {
    ok: true,
    planId: plan.id,
    status: "repaid",
    settleCents,
    feePolicy: cfg.prorateEarlyFee ? "prorated" : "full_fee",
    waivedFeeCents,
    reference,
    message: `Plan settled early · ₦${naira(settleCents)} charged` +
      (waivedFeeCents > 0 ? ` (₦${naira(waivedFeeCents)} future fee waived)` : " (full fee — earned at origination)"),
  };
}

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
