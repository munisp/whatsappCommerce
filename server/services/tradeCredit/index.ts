/**
 * Trade credit engine — public API.
 *
 * S2/S3 import EXACTLY these signatures from this module:
 *
 *   drawOnCredit(args):        Promise<DrawResult>
 *   getCreditAccount(s, b):    Promise<CreditAccount | null>
 *   suggestLimit(b, s):        Promise<{ score; suggestedLimitCents; reasons }>
 *   applyRepayment(args):      Promise<{ ok; outstandingAfter }>
 *   runDunningCheck(now?):     Promise<{ reminded; feesApplied; frozen }>
 *
 * Each public function resolves the shared db handle and delegates to the
 * exported `*Tx` core (which takes the caller's db/tx handle per repo
 * convention — services/inventory.ts — so callers composing larger
 * transactions can reuse the same primitives).
 */
import { getDb } from "../../db";
import type { CreditAccount } from "../../../drizzle/schema";
import { getCreditAccountTx, getCreditAccountByIdTx, type DbHandle } from "./accounts";
import { drawOnCreditTx, type DrawArgs, type DrawResult } from "./draw";
import { applyRepaymentTx, type RepaymentArgs, type RepaymentResult } from "./repayment";
import { suggestLimitTx, type CreditScoreResult } from "./scoring";
import { runDunningCheckTx, type DunningResult } from "./dunning";
import { reviseLimitsTx, type ReviseLimitsResult } from "./limits";
import { applyMandateRepaymentTx, type MandateRepaymentResult } from "./capture";
import {
  isOrderAccessSuspendedTx,
  settleDrawToSupplierTx,
  suspendOrderAccessTx,
  type SettleDrawResult,
} from "./enforcement";

// Re-export the tx-level cores and account-admin helpers for the router and
// for other services composing credit flows inside larger transactions.
export * from "./accounts";
export { drawOnCreditTx, tenureGateDays, type DrawArgs, type DrawResult } from "./draw";
export { applyRepaymentTx, type RepaymentArgs, type RepaymentResult } from "./repayment";
export {
  suggestLimitTx,
  formatNairaCompact,
  FLOOR_LIMIT_CENTS,
  CAP_LIMIT_CENTS,
  type CreditScoreResult,
} from "./scoring";
export { runDunningCheckTx, LATE_FEE_RATE, FREEZE_AFTER_DAYS, type DunningResult } from "./dunning";
// ── W18: credit-outcome-aware scoring, anti-gaming, risk-based terms ──────
export {
  SCORING_WEIGHTS,
  CREDIT_HISTORY,
  creditFactorFromSignals,
} from "./scoring";
export {
  adjustVolumeTx,
  analyzeVolume,
  VELOCITY_SPIKE_MULTIPLIER,
  CIRCULAR_SHARE_THRESHOLD,
  type AntiGamingResult,
} from "./antiGaming";
export { termsForScore, TERMS_BANDS, type CreditTerms, type TermsBand } from "./terms";
// ── W21: ML probability-of-default model + expected-loss pricing ───────────
export {
  PD_MODEL_PARAMS,
  PD_FEATURE_NAMES,
  EL_PRICING,
  scorePd,
  trainPdModelTx,
  loadLatestPdModel,
  resolvePdModel,
  runPdModelTick,
  expectedLossTerms,
  buildPdTrainingRows,
  buyerPdSignalsTx,
  pdFeaturesFromSignals,
  trainLogisticRegression as trainPdLogisticRegression,
  type PdScoreResult,
  type PdTrainResult,
  type PdModelTickSummary,
  type StoredPdModel,
  type ExpectedLossTerms,
} from "./mlPdScoring";
// ── W13: credit control plane + repayment-at-source ─────────────────────────
export { reviseLimitsTx, type ReviseLimitsResult, type LimitRevisionReason } from "./limits";
export {
  applyMandateRepaymentTx,
  repaymentReference,
  __setDunningNoticeForTests,
  type MandateRepaymentResult,
  type DunningNoticeFn,
} from "./capture";
export {
  suspendOrderAccessTx,
  liftOrderAccessTx,
  isOrderAccessSuspendedTx,
  settleDrawToSupplierTx,
  type SuspendArgs,
  type SettleDrawResult,
  type SettleDrawToSupplierArgs,
} from "./enforcement";

// ── W27 credit: merchant micro-loans (working capital) ──────────────────────
export {
  getLoanOffersTx,
  getLoanOffers,
  acceptLoanTx,
  acceptLoan,
  repayLoanManualTx,
  runLoanRepaymentSweepTx,
  runLoanRepaymentSweep,
  listLoansTx,
  repaymentScheduleFor,
  tierForScore,
  sizeOffer,
  deductionForSale,
  loanRepaymentRef,
  LOAN_TIERS,
  MIN_LOAN_CENTS,
  MAX_LOAN_CENTS,
  DEFAULT_GRACE_DAYS,
  type LoanTier,
  type LoanOffer,
  type OffersResult,
  type AcceptLoanResult,
  type LoanSweepResult,
  type RepaymentScheduleEntry,
} from "./microLoans";

async function requireDb(): Promise<DbHandle> {
  const db = await getDb();
  if (!db) throw new Error("[tradeCredit] database unavailable");
  return db;
}

export async function drawOnCredit(args: {
  supplierTenantId: string;
  buyerTenantId: string;
  amountCents: number;
  poId: string;
  termsDays?: number;
}): Promise<DrawResult> {
  return drawOnCreditTx(await requireDb(), args);
}

export async function getCreditAccount(
  supplierTenantId: string,
  buyerTenantId: string,
): Promise<CreditAccount | null> {
  return getCreditAccountTx(await requireDb(), supplierTenantId, buyerTenantId);
}

export async function suggestLimit(
  buyerTenantId: string,
  supplierTenantId: string,
): Promise<{ score: number; suggestedLimitCents: number; reasons: string[] }> {
  return suggestLimitTx(await requireDb(), buyerTenantId, supplierTenantId);
}

export async function applyRepayment(args: {
  accountId: string;
  amountCents: number;
  ref: string;
}): Promise<{ ok: boolean; outstandingAfter: number }> {
  return applyRepaymentTx(await requireDb(), args);
}

export async function runDunningCheck(now?: Date): Promise<{
  reminded: number;
  feesApplied: number;
  frozen: number;
}> {
  return runDunningCheckTx(await requireDb(), now ?? new Date());
}

// ── W13 public API ───────────────────────────────────────────────────────────

/**
 * Buyer-initiated repayment (W13): when the facility has an ACTIVE mandate
 * the repayment is charged AT SOURCE first (exactly-once reference claim,
 * then FIFO settlement on success); on charge failure (or no mandate) the
 * result tells the caller to fall back to the payment-link flow. The plain
 * applyRepayment above stays the SETTLEMENT primitive (used by the
 * payment-link confirm hook) and never charges a mandate.
 */
export async function requestRepayment(args: {
  accountId: string;
  amountCents: number;
  currency?: string;
}): Promise<MandateRepaymentResult> {
  return applyMandateRepaymentTx(await requireDb(), args);
}

/** Scorer-driven limit revision (downward applies immediately, clamped at
 *  outstanding); null when the account does not exist. */
export async function reviseLimits(accountId: string): Promise<ReviseLimitsResult | null> {
  return reviseLimitsTx(await requireDb(), { accountId });
}

/** Suspend the buyer's credit-backed order access with a supplier. */
export async function suspendOrderAccess(args: {
  buyerTenantId: string;
  supplierTenantId: string;
  reason: string;
}): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  return suspendOrderAccessTx(await requireDb(), args);
}

/** True when the buyer's order access with the supplier is suspended
 *  (false when no facility exists for the pair). */
export async function isOrderAccessSuspended(
  buyerTenantId: string,
  supplierTenantId: string,
): Promise<boolean> {
  return isOrderAccessSuspendedTx(await requireDb(), buyerTenantId, supplierTenantId);
}

/** Mark the PO linked to a successful credit draw as paid-via-credit. */
export async function settleDrawToSupplier(args: {
  poId: string;
  drawResult: Extract<DrawResult, { ok: true }>;
}): Promise<SettleDrawResult> {
  return settleDrawToSupplierTx(await requireDb(), args);
}

/** Read helper for the router: account by id. */
export async function getCreditAccountById(accountId: string): Promise<CreditAccount | null> {
  return getCreditAccountByIdTx(await requireDb(), accountId);
}
