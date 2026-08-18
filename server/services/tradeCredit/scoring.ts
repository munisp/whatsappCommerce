/**
 * Credit scoring — deterministic, unit-testable limit suggestions.
 *
 * Inputs (platform history, buyer side):
 *   - 30-day order volume: the buyer tenant's own order GMV over the
 *     trailing 30 days (orders.totalAmount, decimal major units → cents) —
 *     a proxy for repayment capacity. W18: adjusted by the anti-gaming
 *     detector (antiGaming.adjustVolumeTx) so self-dealing / wash volume
 *     does not inflate the suggestion.
 *   - Tenure: whole months since the buyer tenant's first order (0 when no
 *     orders yet).
 *   - Payment timeliness: share of the buyer's completed payment_transactions
 *     paid within 24h of initiation (paidAt - createdAt <= 24h).
 *   - W18 CREDIT HISTORY: the buyer's credit outcomes on this platform
 *     (creditAccounts + creditLedger across ALL suppliers — platform-wide
 *     behavior, documented). Signals:
 *       · facilities repaid on time            (+0.10 each, cap 3)
 *       · late repayments (dunning fee/freeze  (−0.15 each, cap 3)
 *         markers on the draw)
 *       · active default / frozen account      (−0.40, heavy)
 *       · cure-at-zero recovery (late markers  (+0.10, partial; only when not
 *         but outstanding back to 0)            in active default)
 *       · utilization in the healthy band      (+0.05)
 *         (0 < outstanding/limit ≤ 70%)
 *
 * Formula (deterministic — no randomness, no external calls):
 *   onTime       = on-time rate of completed payments; 0.5 when no completed
 *                  payments exist (neutral prior).
 *   creditFactor = 0.5 neutral base adjusted by the signals above, clamped
 *                  to 0..1.
 *   volumeFactor = min(1, adjustedVol30dCents / VOLUME_TARGET_CENTS)
 *                  scaled by (1 - antiGaming.confidencePenalty)
 *   tenureFactor = min(1, tenureMonths / 12)                   // 1y = full
 *
 *   Weights (exported as SCORING_WEIGHTS): with NO credit history the legacy
 *   weights apply (behavior unchanged for new-to-credit buyers):
 *       score = 100 * (0.5*onTime + 0.3*volume + 0.2*tenure)
 *   With credit history, credit history is the DOMINANT signal:
 *       score = 100 * (0.5*credit + 0.25*onTime + 0.15*volume + 0.1*tenure)
 *   score is rounded and clamped to 0..100.
 *
 *   Cold start (no orders AND no payments AND no credit history):
 *   score = COLD_START_SCORE (10), suggestedLimitCents = FLOOR_LIMIT_CENTS
 *   (₦50k) — conservative floor.
 *
 *   Otherwise:
 *   suggestedLimitCents = clamp(
 *       round(adjustedVol30dCents * (0.2 + 0.8 * score/100) / 1000) * 1000,
 *       FLOOR_LIMIT_CENTS, CAP_LIMIT_CENTS)                    // ₦50k..₦50M
 *   i.e. a facility sized between 20% and 100% of a month's volume, scaled
 *   by trust (score), rounded to whole ₦10 (1000 cents).
 *
 * W18: the result also carries `terms` — the risk-based tenor/fee band for
 * the score (terms.termsForScore); score < 20 yields terms.decline = true.
 *
 * `supplierTenantId` is part of the signature for future per-supplier
 * weighting; scoring today is platform-wide (documented so callers do not
 * assume otherwise).
 */
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { creditAccounts, creditLedger, orders, paymentTransactions } from "../../../drizzle/schema";
import type { TxHandle } from "./accounts";
import { adjustVolumeTx, FLAG_UNAVAILABLE, CONFIDENCE_PENALTY_CAP, CONFIDENCE_PENALTY_PER_FLAG, type AntiGamingResult } from "./antiGaming";
import { termsForScore, type CreditTerms } from "./terms";

export const VOLUME_TARGET_CENTS = 500_000_000; // ₦5,000,000
export const FLOOR_LIMIT_CENTS = 5_000_000; // ₦50,000
export const CAP_LIMIT_CENTS = 5_000_000_000; // ₦50,000,000
export const COLD_START_SCORE = 10;
export const ON_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * W18 score weights, documented in one place. `noCreditHistory` is the
 * legacy wave-12 formula (new-to-credit buyers: behavior unchanged);
 * `withCreditHistory` makes platform credit outcomes the dominant signal.
 */
export const SCORING_WEIGHTS = {
  noCreditHistory: { onTime: 0.5, volume: 0.3, tenure: 0.2 },
  withCreditHistory: { credit: 0.5, onTime: 0.25, volume: 0.15, tenure: 0.1 },
} as const;

/** W18 credit-history signal magnitudes (creditFactor starts at 0.5). */
export const CREDIT_HISTORY = {
  onTimeFacilityBonus: 0.1, // per facility repaid on time (cap 3)
  lateRepaymentPenalty: 0.15, // per late draw (cap 3)
  activeDefaultPenalty: 0.4, // frozen account / draw overdue past freeze horizon
  cureAtZeroBonus: 0.1, // late markers but outstanding back to 0
  healthyUtilizationBonus: 0.05, // 0 < outstanding/limit ≤ 70%
  maxCounted: 3,
  healthyUtilizationMax: 0.7,
} as const;

export interface CreditScoreResult {
  score: number;
  suggestedLimitCents: number;
  reasons: string[];
  /** W18: risk-based terms band for the score (decline below 20). */
  terms: CreditTerms;
  /** W18: anti-gaming flags on the GMV input ([] when clean). */
  antiGamingFlags: string[];
  /**
   * W21: probability of default (0..1) from the ML PD model when trained
   * (mlPdScoring.scorePd), otherwise the rule proxy (1 − score/100).
   * Additive/optional — absent only if the PD call itself failed.
   */
  pd?: number;
  /** W21: which path produced `pd` — trained ML model or rule proxy. */
  pdSource?: "ml" | "rules";
  /**
   * W21: expected-loss fee (bps), capped at the rule-score band fee (bands
   * remain policy caps — ML can only improve on them, never worsen them).
   */
  expectedLossFeeBps?: number;
  /**
   * W22: contextual-bandit decision metadata (services/banditLimits.ts).
   * Present when the bandit logged a decision row. In shadow mode (the
   * default) the returned suggestedLimitCents is the unchanged rule-based
   * baseline; in active mode (BANDIT_LIMITS_MODE=active + gate met) it is
   * the bandit's cap-clamped choice.
   */
  bandit?: { chosenMultiplier: number; mode: "shadow" | "active" };
}

/** "₦2.4M" / "₦850k" / "₦12,000" compact naira formatting for reasons. */
export function formatNairaCompact(cents: number): string {
  const naira = cents / 100;
  if (naira >= 1_000_000) {
    const m = naira / 1_000_000;
    return `₦${Number(m.toFixed(1))}M`;
  }
  if (naira >= 100_000) return `₦${Math.round(naira / 1_000)}k`;
  return `₦${Math.round(naira).toLocaleString("en-US")}`;
}

/** Dunning markers proving a draw was repaid late (see dunning.ts). */
const LATE_MARKERS = ["[dun:fee]", "[dun:r+7]"] as const;
const FREEZE_OVERDUE_DAYS = 7;

interface CreditHistorySignals {
  hasHistory: boolean;
  onTimeFacilities: number;
  lateRepayments: number;
  activeDefault: boolean;
  curedAtZero: boolean;
  healthyUtilization: boolean;
}

/** Aggregate platform-wide credit outcomes for the buyer tenant. */
async function creditHistorySignalsTx(
  db: TxHandle,
  buyerTenantId: string,
  now: Date,
): Promise<CreditHistorySignals> {
  const accounts = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.buyerTenantId, buyerTenantId));
  const sig: CreditHistorySignals = {
    hasHistory: false,
    onTimeFacilities: 0,
    lateRepayments: 0,
    activeDefault: false,
    curedAtZero: false,
    healthyUtilization: false,
  };
  for (const account of accounts) {
    const rows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.creditAccountId, account.id));
    const draws = rows.filter((r) => r.kind === "invoice_draw" && r.status !== "void");
    const repayments = rows.filter((r) => r.kind === "repayment" && r.status !== "void");
    if (draws.length === 0 && repayments.length === 0) continue;
    sig.hasHistory = true;

    const lateDraws = draws.filter((d) =>
      LATE_MARKERS.some((m) => (d.note ?? "").includes(m)),
    );
    sig.lateRepayments += lateDraws.length;

    if (account.status === "frozen") sig.activeDefault = true;
    const overduePosted = draws.some((d) => {
      if (d.status !== "posted" || !d.dueDate) return false;
      const overdueDays = Math.floor((now.getTime() - new Date(d.dueDate).getTime()) / (24 * 60 * 60 * 1000));
      return overdueDays > FREEZE_OVERDUE_DAYS;
    });
    if (overduePosted) sig.activeDefault = true;

    const settledDraws = draws.filter((d) => d.status === "settled");
    if (
      settledDraws.length > 0 &&
      lateDraws.length === 0 &&
      account.outstandingCents === 0
    ) {
      // Every draw settled, no late markers, balance back to zero.
      sig.onTimeFacilities += 1;
    }
    if (lateDraws.length > 0 && account.outstandingCents === 0) sig.curedAtZero = true;
    if (
      account.limitCents > 0 &&
      account.outstandingCents > 0 &&
      account.outstandingCents / account.limitCents <= CREDIT_HISTORY.healthyUtilizationMax
    ) {
      sig.healthyUtilization = true;
    }
  }
  return sig;
}

/** creditFactor (0..1) from the aggregated signals; 0.5 is neutral. */
export function creditFactorFromSignals(sig: CreditHistorySignals): number {
  const cap = CREDIT_HISTORY.maxCounted;
  let f = 0.5;
  f += CREDIT_HISTORY.onTimeFacilityBonus * Math.min(cap, sig.onTimeFacilities);
  f -= CREDIT_HISTORY.lateRepaymentPenalty * Math.min(cap, sig.lateRepayments);
  if (sig.activeDefault) f -= CREDIT_HISTORY.activeDefaultPenalty;
  else if (sig.curedAtZero) f += CREDIT_HISTORY.cureAtZeroBonus;
  if (sig.healthyUtilization) f += CREDIT_HISTORY.healthyUtilizationBonus;
  return Math.max(0, Math.min(1, f));
}

export async function suggestLimitTx(
  db: TxHandle,
  buyerTenantId: string,
  _supplierTenantId: string,
  now: Date = new Date(),
  opts: { bandit?: boolean } = {},
): Promise<CreditScoreResult> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // 30-day order volume (buyer tenant's own GMV).
  const recentOrders = await db
    .select({ totalAmount: orders.totalAmount })
    .from(orders)
    .where(and(eq(orders.tenantId, buyerTenantId), gte(orders.createdAt, since30d)))
    .orderBy(desc(orders.createdAt));
  const rawVol30dCents = recentOrders.reduce(
    (sum, o) => sum + Math.round(Number(o.totalAmount) * 100),
    0,
  );

  // Tenure: months since first order.
  const [firstOrder] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .where(eq(orders.tenantId, buyerTenantId))
    .orderBy(asc(orders.createdAt))
    .limit(1);
  const tenureMonths = firstOrder
    ? Math.max(0, Math.floor((now.getTime() - new Date(firstOrder.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000)))
    : 0;

  // Payment timeliness.
  const completedPayments = await db
    .select({ createdAt: paymentTransactions.createdAt, paidAt: paymentTransactions.paidAt })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.tenantId, buyerTenantId), eq(paymentTransactions.status, "completed")))
    .orderBy(desc(paymentTransactions.createdAt));
  const onTimeCount = completedPayments.filter((p) => {
    if (!p.paidAt) return false;
    return new Date(p.paidAt).getTime() - new Date(p.createdAt).getTime() <= ON_TIME_WINDOW_MS;
  }).length;
  const hasPayments = completedPayments.length > 0;
  const onTime = hasPayments ? onTimeCount / completedPayments.length : 0.5;

  // W18: platform-wide credit history (all suppliers).
  const creditSig = await creditHistorySignalsTx(db, buyerTenantId, now);
  const creditFactor = creditFactorFromSignals(creditSig);

  // W18: anti-gaming adjustment of the 30-day GMV input (fail-open).
  let antiGaming: AntiGamingResult;
  try {
    antiGaming = await adjustVolumeTx(db, buyerTenantId, now);
  } catch {
    antiGaming = {
      rawVolumeCents: rawVol30dCents,
      adjustedVolumeCents: rawVol30dCents,
      flags: [FLAG_UNAVAILABLE],
      confidencePenalty: 0,
    };
  }
  const vol30dCents = antiGaming.adjustedVolumeCents;

  // ── W22: graph-collusion signal (additive, fail-open) ────────────────────
  // When an open graph alert ≥ threshold exists for this buyer (written by
  // scanGraphCollusionTx), add the 'graph-collusion' flag and apply the same
  // confidence-penalty pattern (0.2 per flag, respecting the 0.5 cap). If
  // the graph signal is unavailable or errors, no flag is added and the
  // existing heuristics are unchanged.
  try {
    const { hasGraphCollusionSignalTx, GRAPH_FLAG } = await import("../graphCollusion");
    const g = await hasGraphCollusionSignalTx(db, buyerTenantId);
    if (g.flagged && !antiGaming.flags.includes(GRAPH_FLAG)) {
      antiGaming = {
        ...antiGaming,
        flags: [...antiGaming.flags, GRAPH_FLAG],
        confidencePenalty: Math.min(
          CONFIDENCE_PENALTY_CAP,
          (antiGaming.flags.length + 1) * CONFIDENCE_PENALTY_PER_FLAG,
        ),
      };
    }
  } catch {
    // Graph signal is best-effort; the rule-based result stands alone.
  }

  // ── Formula ──────────────────────────────────────────────────────────────
  const coldStart = recentOrders.length === 0 && !firstOrder && !hasPayments && !creditSig.hasHistory;
  let score: number;
  let suggestedLimitCents: number;
  const reasons: string[] = [];

  if (coldStart) {
    score = COLD_START_SCORE;
    suggestedLimitCents = FLOOR_LIMIT_CENTS;
    reasons.push("no platform history — conservative cold-start floor");
    reasons.push(`${formatNairaCompact(0)} 30-day volume`);
    reasons.push("0 months tenure");
  } else {
    const volumeFactor =
      Math.min(1, vol30dCents / VOLUME_TARGET_CENTS) * (1 - antiGaming.confidencePenalty);
    const tenureFactor = Math.min(1, tenureMonths / 12);
    const w = creditSig.hasHistory ? SCORING_WEIGHTS.withCreditHistory : SCORING_WEIGHTS.noCreditHistory;
    const weighted =
      "credit" in w
        ? w.credit * creditFactor + w.onTime * onTime + w.volume * volumeFactor + w.tenure * tenureFactor
        : w.onTime * onTime + w.volume * volumeFactor + w.tenure * tenureFactor;
    score = Math.max(0, Math.min(100, Math.round(100 * weighted)));
    const raw = vol30dCents * (0.2 + 0.8 * (score / 100));
    suggestedLimitCents = Math.max(FLOOR_LIMIT_CENTS, Math.min(CAP_LIMIT_CENTS, Math.round(raw / 1000) * 1000));
    reasons.push(
      hasPayments
        ? `on-time rate ${Math.round(onTime * 100)}%`
        : "no completed payments — neutral on-time prior",
    );
    reasons.push(
      antiGaming.adjustedVolumeCents !== antiGaming.rawVolumeCents
        ? `${formatNairaCompact(vol30dCents)} 30-day volume (adjusted from ${formatNairaCompact(antiGaming.rawVolumeCents)})`
        : `${formatNairaCompact(vol30dCents)} 30-day volume`,
    );
    reasons.push(`${tenureMonths} months tenure`);
    // W18: human-readable credit-history reasons.
    if (creditSig.hasHistory) {
      if (creditSig.onTimeFacilities > 0) {
        reasons.push(
          `credit: ${creditSig.onTimeFacilities} facilit${creditSig.onTimeFacilities === 1 ? "y" : "ies"} repaid on time`,
        );
      }
      if (creditSig.lateRepayments > 0) {
        reasons.push(`credit: ${creditSig.lateRepayments} late repayment${creditSig.lateRepayments === 1 ? "" : "s"}`);
      }
      if (creditSig.activeDefault) reasons.push("credit: active default / frozen account");
      else if (creditSig.curedAtZero) reasons.push("credit: recovered to zero after late repayment");
      if (creditSig.healthyUtilization) reasons.push("credit: utilization in healthy band");
    }
    // W18: anti-gaming flags are surfaced in the explainability trail.
    for (const flag of antiGaming.flags) reasons.push(`anti-gaming flag: ${flag}`);
  }

  const terms = termsForScore(score);
  if (terms.decline && !coldStart) {
    reasons.push(`score ${score} below 20 — decline credit suggestion`);
  }

  // ── W21: ML probability-of-default + expected-loss fee (additive) ───────
  // ML-first: when a trained PD model exists (tenant scope, else global
  // corpus) the PD comes from the model; otherwise the rule proxy
  // (pd = 1 − score/100) is used. Never throws — any failure simply omits
  // the PD fields and the rule-based result is returned unchanged.
  let pd: number | undefined;
  let pdSource: "ml" | "rules" | undefined;
  let expectedLossFeeBps: number | undefined;
  try {
    const { scorePd, expectedLossTerms } = await import("./mlPdScoring");
    const pdRes = await scorePd(db, _supplierTenantId, buyerTenantId, { now, ruleScore: score });
    pd = Math.round(pdRes.pd * 1e6) / 1e6;
    pdSource = pdRes.fallbackUsed ? "rules" : "ml";
    // Bands remain policy caps: the expected-loss fee never exceeds the fee
    // the rule-score band implies. A declined band has tenor 0 — price the
    // informational EL fee at the baseline tenor instead.
    const { EL_PRICING } = await import("./mlPdScoring");
    const el = expectedLossTerms(pdRes.pd, terms.decline ? EL_PRICING.tenorBaselineDays : terms.tenorDays);
    expectedLossFeeBps = terms.decline ? el.feeBps : Math.min(el.feeBps, terms.feeBps);
  } catch {
    // PD enrichment is best-effort; the rule-based result stands alone.
  }

  // ── W22: contextual-bandit limit decision (additive) ────────────────────
  // The bandit logs its chosen multiplier (bandit_decisions row) in shadow
  // mode by default — the returned limit is UNCHANGED. Only with
  // BANDIT_LIMITS_MODE=active AND the min-rewarded-decisions gate met does
  // the bandit's (envelope-clamped) choice replace the suggestion. Program
  // callers pass bandit:false here and apply the bandit AFTER program caps
  // (suggestLimitForProgramTx). Never throws; failures omit the field.
  let bandit: CreditScoreResult["bandit"];
  let finalSuggested = suggestedLimitCents;
  if (opts.bandit !== false) {
    try {
      const { banditSuggestTx } = await import("../banditLimits");
      const res = await banditSuggestTx(db, {
        tenantId: _supplierTenantId,
        buyerId: buyerTenantId,
        baselineLimitCents: suggestedLimitCents,
        pd,
        now,
      });
      if (!res.fallbackUsed) {
        bandit = { chosenMultiplier: res.chosenMultiplier, mode: res.mode };
        if (res.mode === "active") finalSuggested = res.suggestedLimitCents;
      }
    } catch {
      // Bandit logging is best-effort; the rule-based result stands alone.
    }
  }

  return { score, suggestedLimitCents: finalSuggested, reasons, terms, antiGamingFlags: antiGaming.flags, pd, pdSource, expectedLossFeeBps, bandit };
}
