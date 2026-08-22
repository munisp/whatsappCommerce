/**
 * W27 credit — merchant credit score (frozen contract).
 *
 *   getMerchantScore(tenantId, merchantId, db)
 *     → { score: number (0-1000), factors: {...}, computedAt }
 *
 * Coders E/F/G: import getMerchantScore / MerchantScoreResult from THIS
 * module; the signature is frozen by SPEC_W27.
 *
 * Deterministic factor model over real platform data. All math is integer
 * (points are integers, money is integer cents); no unseeded randomness;
 * no wall-clock reads inside the pure scoring core (the caller passes
 * `now`). Factor weights (total 1000):
 *
 *   orderVolume        200  completed (delivered) orders in window, saturates at 50
 *   completionRate     150  delivered / considered orders (excl. pending)
 *   codCollectionRate  150  COD cash_collected / COD orders reaching collection
 *   paymentSuccessRate 150  completed psp payments / (completed + failed)
 *   refundDisputeRate  150  inverse of (refunds + buyer disputes) per order (5x sensitivity)
 *   tenure             100  merchant tenure, saturates at 365 days
 *   trustScore         100  external review/trust score (0-100) when present
 *
 * Cold-start rule (documented, deterministic): rate factors with NO
 * observations earn exactly HALF their weight (a new merchant is neither
 * penalised nor credited); refundDispute with no orders earns FULL weight
 * (zero refunds on zero orders is a fact, not an absence of evidence).
 */
import { and, eq, gte, ne, sql, type SQL } from "drizzle-orm";
import {
  codEvents,
  escrowDisputes,
  merchantCreditScores,
  orders,
  paymentTransactions,
  refunds,
  tenants,
} from "../../drizzle/schema";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";
import type { DbHandle } from "./tradeCredit/accounts";

/** Frozen contract result type. */
export interface MerchantScoreFactors {
  orderVolume: { points: number; weight: 200; completedOrders: number; saturation: 50 };
  completionRate: { points: number; weight: 150; ratePct: number | null; considered: number };
  codCollectionRate: { points: number; weight: 150; ratePct: number | null; codOrders: number };
  paymentSuccessRate: { points: number; weight: 150; ratePct: number | null; attempts: number };
  refundDisputeRate: { points: number; weight: 150; adverseEvents: number; ratePct: number | null };
  tenure: { points: number; weight: 100; days: number; saturation: 365 };
  trustScore: { points: number; weight: 100; trustScore: number | null };
  /** 90-day trailing sales volume in integer cents (signal for loan sizing). */
  salesVolumeCents90d: number;
  /** Total considered orders in the scoring window. */
  ordersConsidered: number;
}

export interface MerchantScoreResult {
  score: number; // 0-1000 integer
  factors: MerchantScoreFactors;
  computedAt: Date;
}

/** Raw signals gathered from the db (or supplied directly in tests). */
export interface MerchantScoreSignals {
  /** Orders created in the scoring window, split by status. */
  totalOrders: number;          // all orders in window
  completedOrders: number;      // status = 'delivered'
  cancelledOrders: number;      // status = 'cancelled'
  refundedOrders: number;       // status = 'refunded'
  pendingOrders: number;        // status pending/confirmed/processing/shipped
  /** Trailing 90d sales volume (delivered+paid orders), integer cents. */
  salesVolumeCents: number;
  /** COD outcomes in window. */
  codOrdersTotal: number;       // orders with a codState (any COD flow)
  codCollected: number;         // orders with a cash_collected event
  codFailed: number;            // orders with a delivery_failed/cancelled event
  /** PSP payment outcomes in window. */
  paymentsCompleted: number;
  paymentsFailed: number;
  /** Adverse events in window. */
  refundCount: number;
  buyerDisputeCount: number;
  /** Tenure in whole days at `now`. */
  tenureDays: number;
  /** External trust score 0-100 when a reviews/trust module provides one. */
  trustScore: number | null;
}

export const SCORING_WINDOW_DAYS = 90;
export const VOLUME_SATURATION_ORDERS = 50;
export const TENURE_SATURATION_DAYS = 365;
/** Refund/dispute rate is multiplied by this before clipping (a 20% adverse
 *  rate zeroes the factor). */
export const ADVERSE_SENSITIVITY = 5;

/** Points = round(ratePct/100 * weight); ratePct null → cold-start half weight. */
function ratePoints(ratePct: number | null, weight: number): number {
  if (ratePct == null) return Math.floor(weight / 2);
  return Math.round((ratePct / 100) * weight);
}

/** Percent as integer 0-100 (x/y, 4-decimal fixed-point, round half up). */
export function pctInt(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator * 10000) / denominator / 100);
}

/**
 * Pure scoring core — deterministic, integer-only, unit-testable. Takes
 * pre-aggregated signals; returns the frozen {score, factors} shape (no
 * computedAt — the caller stamps it).
 */
export function computeScoreFromSignals(
  signals: MerchantScoreSignals,
): { score: number; factors: MerchantScoreFactors } {
  // 1. Order volume (200): linear saturation at VOLUME_SATURATION_ORDERS.
  const volCapped = Math.min(signals.completedOrders, VOLUME_SATURATION_ORDERS);
  const volumePoints = Math.round((volCapped / VOLUME_SATURATION_ORDERS) * 200);

  // 2. Completion rate (150): delivered / considered (excludes pending).
  const considered =
    signals.completedOrders + signals.cancelledOrders + signals.refundedOrders;
  const completionPct = considered > 0 ? pctInt(signals.completedOrders, considered) : null;
  const completionPoints = ratePoints(completionPct, 150);

  // 3. COD collection rate (150).
  const codResolved = signals.codCollected + signals.codFailed;
  const codPct = codResolved > 0 ? pctInt(signals.codCollected, codResolved) : null;
  const codPoints = ratePoints(codPct, 150);

  // 4. Payment success rate (150).
  const attempts = signals.paymentsCompleted + signals.paymentsFailed;
  const payPct = attempts > 0 ? pctInt(signals.paymentsCompleted, attempts) : null;
  const payPoints = ratePoints(payPct, 150);

  // 5. Refund/dispute rate (150): inverse, 5x sensitivity.
  const adverseEvents = signals.refundCount + signals.buyerDisputeCount;
  let refundPoints: number;
  let adversePct: number | null;
  if (signals.totalOrders > 0) {
    adversePct = pctInt(adverseEvents, signals.totalOrders);
    const scaled = Math.min(adversePct * ADVERSE_SENSITIVITY, 100);
    refundPoints = Math.round(((100 - scaled) / 100) * 150);
  } else {
    adversePct = null;
    refundPoints = 150; // zero adverse events on zero orders
  }

  // 6. Tenure (100): linear saturation at 365 days.
  const tenureCapped = Math.min(Math.max(signals.tenureDays, 0), TENURE_SATURATION_DAYS);
  const tenurePoints = Math.round((tenureCapped / TENURE_SATURATION_DAYS) * 100);

  // 7. Trust score (100): external 0-100 when present, else cold-start half.
  const trustClamped =
    signals.trustScore == null
      ? null
      : Math.max(0, Math.min(100, Math.round(signals.trustScore)));
  const trustPoints = ratePoints(trustClamped, 100);

  const score = Math.max(
    0,
    Math.min(
      1000,
      volumePoints + completionPoints + codPoints + payPoints +
        refundPoints + tenurePoints + trustPoints,
    ),
  );

  return {
    score,
    factors: {
      orderVolume: {
        points: volumePoints, weight: 200,
        completedOrders: signals.completedOrders, saturation: VOLUME_SATURATION_ORDERS,
      },
      completionRate: { points: completionPoints, weight: 150, ratePct: completionPct, considered },
      codCollectionRate: { points: codPoints, weight: 150, ratePct: codPct, codOrders: signals.codOrdersTotal },
      paymentSuccessRate: { points: payPoints, weight: 150, ratePct: payPct, attempts },
      refundDisputeRate: { points: refundPoints, weight: 150, adverseEvents, ratePct: adversePct },
      tenure: { points: tenurePoints, weight: 100, days: Math.max(signals.tenureDays, 0), saturation: TENURE_SATURATION_DAYS },
      trustScore: { points: trustPoints, weight: 100, trustScore: trustClamped },
      salesVolumeCents90d: signals.salesVolumeCents,
      ordersConsidered: signals.totalOrders,
    },
  };
}

type CountRow = { n: number };

async function countWhere(
  db: DbHandle,
  table: any,
  where: SQL | undefined,
): Promise<number> {
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(where)) as unknown as CountRow[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * Frozen contract entry point. Gathers trailing-90d signals for the merchant
 * from real platform tables, scores them deterministically, upserts the
 * cache row (merchant_credit_scores) and returns {score, factors, computedAt}.
 *
 * `merchantId` is the merchant's tenant id on this platform (merchants are
 * first-class tenants); `tenantId` is the owning/operating tenant — for
 * first-party use they are the same id. The score is scoped to the
 * (tenantId, merchantId) pair.
 */
export async function getMerchantScore(
  tenantId: string,
  merchantId: string,
  db: DbHandle,
  opts?: { now?: Date; trustScore?: number | null; persist?: boolean },
): Promise<MerchantScoreResult> {
  const now = opts?.now ?? new Date();
  const windowStart = new Date(now.getTime() - SCORING_WINDOW_DAYS * 24 * 3600 * 1000);
  const m = merchantId;

  const inWindow = gte(orders.createdAt, windowStart);
  const [
    totalOrders,
    completedOrders,
    cancelledOrders,
    refundedOrders,
    pendingOrders,
    volumeRows,
    codOrdersTotal,
    codCollectedOrders,
    codFailedOrders,
    paymentsCompleted,
    paymentsFailed,
    refundCount,
    buyerDisputeCount,
    tenantRow,
  ] = await Promise.all([
    countWhere(db, orders, and(eq(orders.tenantId, m), inWindow)),
    countWhere(db, orders, and(eq(orders.tenantId, m), inWindow, eq(orders.status, "delivered"))),
    countWhere(db, orders, and(eq(orders.tenantId, m), inWindow, eq(orders.status, "cancelled"))),
    countWhere(db, orders, and(eq(orders.tenantId, m), inWindow, eq(orders.status, "refunded"))),
    countWhere(db, orders, and(
      eq(orders.tenantId, m), inWindow,
      ne(orders.status, "delivered"), ne(orders.status, "cancelled"), ne(orders.status, "refunded"),
    )),
    db.select({ total: sql<string>`coalesce(sum(${orders.totalAmount}), 0)` })
      .from(orders)
      .where(and(eq(orders.tenantId, m), inWindow, eq(orders.status, "delivered"))),
    countWhere(db, orders, and(
      eq(orders.tenantId, m), inWindow, sql`${orders.codState} is not null`,
    )),
    countWhere(db, codEvents, and(
      eq(codEvents.tenantId, m), gte(codEvents.createdAt, windowStart),
      eq(codEvents.toState, "cash_collected"),
    )),
    countWhere(db, codEvents, and(
      eq(codEvents.tenantId, m), gte(codEvents.createdAt, windowStart),
      sql`${codEvents.toState} in ('delivery_failed','cancelled')`,
    )),
    countWhere(db, paymentTransactions, and(
      eq(paymentTransactions.tenantId, m), gte(paymentTransactions.createdAt, windowStart),
      eq(paymentTransactions.status, "completed"),
    )),
    countWhere(db, paymentTransactions, and(
      eq(paymentTransactions.tenantId, m), gte(paymentTransactions.createdAt, windowStart),
      eq(paymentTransactions.status, "failed"),
    )),
    countWhere(db, refunds, and(
      eq(refunds.tenantId, m), gte(refunds.createdAt, windowStart),
    )),
    countWhere(db, escrowDisputes, and(
      eq(escrowDisputes.tenantId, m), gte(escrowDisputes.createdAt, windowStart),
      eq(escrowDisputes.raisedBy, "buyer"),
    )),
    db.select({ createdAt: tenants.createdAt }).from(tenants).where(eq(tenants.id, m)).limit(1),
  ]);

  const totalAmountStr = (volumeRows as unknown as { total: string }[])[0]?.total ?? "0";
  const salesVolumeCents = toMinorUnitsExact(totalAmountStr === "0" ? "0" : totalAmountStr);

  const createdAt = tenantRow[0]?.createdAt ?? null;
  const tenureDays = createdAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / (24 * 3600 * 1000)))
    : 0;

  const signals: MerchantScoreSignals = {
    totalOrders,
    completedOrders,
    cancelledOrders,
    refundedOrders,
    pendingOrders,
    salesVolumeCents,
    codOrdersTotal,
    codCollected: codCollectedOrders,
    codFailed: codFailedOrders,
    paymentsCompleted,
    paymentsFailed,
    refundCount,
    buyerDisputeCount,
    tenureDays,
    trustScore: opts?.trustScore ?? null,
  };
  const { score, factors } = computeScoreFromSignals(signals);

  if (opts?.persist !== false) {
    await db
      .insert(merchantCreditScores)
      .values({ tenantId, merchantId: m, score, factors, computedAt: now })
      .onConflictDoUpdate({
        target: [merchantCreditScores.tenantId, merchantCreditScores.merchantId],
        set: { score, factors, computedAt: now, updatedAt: now },
      });
  }

  return { score, factors, computedAt: now };
}
