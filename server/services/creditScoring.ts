// === W56 credit ===
/**
 * W56 credit scoring — automated INTERNAL credit score for buyers and
 * merchants (complements the W27 merchant-only getMerchantScore in
 * creditScore.ts, whose frozen contract is untouched).
 *
 * Pure, deterministic, integer-only scoring core over pre-aggregated
 * on-platform signals: same inputs → same score, no wall-clock inside the
 * core (the caller passes `now`), money in integer cents.
 *
 * Factor weights (total 1000):
 *
 *   orderHistory        200  order count (120, saturates at 30 orders) +
 *                            recency (80: ≤7d → 80, ≤30d → 50, ≤90d → 25)
 *   orderVolume         150  trailing-window delivered volume in cents,
 *                            linear saturation at VOLUME_SATURATION_CENTS
 *   repaymentTimeliness 300  on-time vs late vs DEFAULTED credit repayments
 *                            (buyer installments + merchant trade-credit
 *                            loans). points = 300 * onTime /
 *                            (onTime + late + 2*defaulted) — a default
 *                            counts double. Cold-start (no credit history)
 *                            earns exactly HALF weight, mirroring the W27
 *                            cold-start rule: absence of evidence is
 *                            neither penalised nor credited.
 *   disputeHistory      150  inverse: 150 − 30*(disputes + 2*chargebacks),
 *                            floored at 0 (chargebacks count double)
 *   kycStatus           100  KYC/KYB approved → 100; not_started/none → 50
 *                            (cold-start half); any other state → 20
 *   tenure              100  linear saturation at 365 days
 *
 * Grade bands: A ≥ 800, B ≥ 650, C ≥ 500, D ≥ 350, E < 350.
 *
 * Persistence: one row per (tenantId, subjectType, subjectId) in
 * credit_scores (migration 0177), upserted on every recompute with the
 * model version stamp (SCORE_VERSION).
 *
 * Recompute triggers:
 *   1. recomputeAfterPaymentEvent() — post-commit seam for payment
 *      settlement / refund events. Call AFTER the money tx commits
 *      (receipt/payment-confirm pattern); it NEVER throws (fail-open
 *      telemetry) and NEVER blocks the money path.
 *   2. runCreditScoreRefreshSweep() — scheduled sweep behind
 *      /api/scheduled/credit-score-refresh (cronAuth; scheduler.mjs
 *      SCHEDULE allowlist, J178 contract) that recomputes stale rows.
 */
import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import {
  arInvoices,
  buyerInstallmentPlans,
  creditScores,
  customers,
  escrowDisputes,
  kycApplications,
  merchantLoans,
  orders,
  paymentDisputes,
  refunds,
  tenants,
} from "../../drizzle/schema";
import { toMinorUnitsExact } from "../../shared/escrowAmounts";
import type { DbHandle } from "./tradeCredit/accounts";

export type SubjectType = "buyer" | "merchant";
export type Grade = "A" | "B" | "C" | "D" | "E";

export const SCORE_VERSION = "w56-v1";
export const SCORING_WINDOW_DAYS = 90;
export const ORDER_COUNT_SATURATION = 30;
export const VOLUME_SATURATION_CENTS = 500_000_000; // ₦5,000,000
export const TENURE_SATURATION_DAYS = 365;
/** A score row older than this is recomputed by the scheduled sweep. */
export const STALE_AFTER_HOURS = 24;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubjectScoreSignals {
  /** Orders in the scoring window. */
  orderCount: number;
  /** Delivered-order volume in integer cents (window). */
  salesVolumeCents: number;
  /** Whole days since the most recent order; null when no orders. */
  daysSinceLastOrder: number | null;
  /** Credit repayment outcomes (buyer installments / trade-credit loans). */
  repaymentOnTime: number;
  repaymentLate: number;
  repaymentDefaulted: number;
  /** Adverse history: buyer disputes raised + PSP chargebacks (any window). */
  disputeCount: number;
  chargebackCount: number;
  /** KYC/KYB status: 'approved' | 'not_started' | other | null (no record). */
  kycStatus: string | null;
  /** Whole days since the subject first appeared on-platform. */
  tenureDays: number;
}

export interface SubjectScoreFactors {
  orderHistory: { points: number; weight: 200; orderCount: number; daysSinceLastOrder: number | null };
  orderVolume: { points: number; weight: 150; volumeCents: number; saturationCents: number };
  repaymentTimeliness: {
    points: number; weight: 300;
    onTime: number; late: number; defaulted: number; ratePct: number | null;
  };
  disputeHistory: { points: number; weight: 150; disputes: number; chargebacks: number };
  kycStatus: { points: number; weight: 100; status: string | null };
  tenure: { points: number; weight: 100; days: number; saturation: 365 };
}

export interface SubjectScoreResult {
  score: number; // 0-1000 integer
  grade: Grade;
  factors: SubjectScoreFactors;
  version: string;
  computedAt: Date;
}

// ── Pure core ───────────────────────────────────────────────────────────────

export function gradeForScore(score: number): Grade {
  if (score >= 800) return "A";
  if (score >= 650) return "B";
  if (score >= 500) return "C";
  if (score >= 350) return "D";
  return "E";
}

/** Integer percent (x/y, round half up); null-safe at the call site. */
function pctInt(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator * 10000) / denominator / 100);
}

/**
 * Pure scoring core — deterministic, integer-only, unit-testable. Takes
 * pre-aggregated signals; returns score + grade + factors (no computedAt —
 * the caller stamps it).
 */
export function computeSubjectScore(
  signals: SubjectScoreSignals,
): { score: number; grade: Grade; factors: SubjectScoreFactors } {
  // 1. Order history (200): count (120, saturates at 30) + recency (80).
  const countPoints = Math.round(
    (Math.min(Math.max(signals.orderCount, 0), ORDER_COUNT_SATURATION) / ORDER_COUNT_SATURATION) * 120,
  );
  const d = signals.daysSinceLastOrder;
  const recencyPoints = d == null ? 0 : d <= 7 ? 80 : d <= 30 ? 50 : d <= 90 ? 25 : 0;
  const historyPoints = countPoints + recencyPoints;

  // 2. Order volume (150): linear saturation at VOLUME_SATURATION_CENTS.
  const volCapped = Math.min(Math.max(signals.salesVolumeCents, 0), VOLUME_SATURATION_CENTS);
  const volumePoints = Math.round((volCapped / VOLUME_SATURATION_CENTS) * 150);

  // 3. Repayment timeliness (300): onTime / (onTime + late + 2*defaulted).
  //    Cold-start (no credit history) earns exactly half weight.
  const { repaymentOnTime: onTime, repaymentLate: late, repaymentDefaulted: defaulted } = signals;
  const denom = onTime + late + 2 * defaulted;
  let repayPoints: number;
  let repayPct: number | null;
  if (denom === 0) {
    repayPoints = 150; // cold-start half weight (documented W27 parity rule)
    repayPct = null;
  } else {
    repayPct = pctInt(onTime, denom);
    repayPoints = Math.round((repayPct / 100) * 300);
  }

  // 4. Dispute/chargeback history (150): inverse, chargebacks count double.
  const adverseUnits = Math.max(signals.disputeCount, 0) + 2 * Math.max(signals.chargebackCount, 0);
  const disputePoints = Math.max(0, 150 - 30 * adverseUnits);

  // 5. KYC/KYB (100): approved → full; no record/not_started → half; else 20.
  const kyc = signals.kycStatus;
  const kycPoints = kyc === "approved" ? 100 : kyc == null || kyc === "not_started" ? 50 : 20;

  // 6. Tenure (100): linear saturation at 365 days.
  const tenureCapped = Math.min(Math.max(signals.tenureDays, 0), TENURE_SATURATION_DAYS);
  const tenurePoints = Math.round((tenureCapped / TENURE_SATURATION_DAYS) * 100);

  const score = Math.max(
    0,
    Math.min(1000, historyPoints + volumePoints + repayPoints + disputePoints + kycPoints + tenurePoints),
  );

  return {
    score,
    grade: gradeForScore(score),
    factors: {
      orderHistory: { points: historyPoints, weight: 200, orderCount: signals.orderCount, daysSinceLastOrder: d },
      orderVolume: { points: volumePoints, weight: 150, volumeCents: volCapped, saturationCents: VOLUME_SATURATION_CENTS },
      repaymentTimeliness: { points: repayPoints, weight: 300, onTime, late, defaulted, ratePct: repayPct },
      disputeHistory: { points: disputePoints, weight: 150, disputes: signals.disputeCount, chargebacks: signals.chargebackCount },
      kycStatus: { points: kycPoints, weight: 100, status: kyc ?? null },
      tenure: { points: tenurePoints, weight: 100, days: Math.max(signals.tenureDays, 0), saturation: TENURE_SATURATION_DAYS },
    },
  };
}

// ── Signal gathering ────────────────────────────────────────────────────────

type CountRow = { n: number };

async function countWhere(db: DbHandle, table: any, where: SQL | undefined): Promise<number> {
  const rows = (await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where)) as unknown as CountRow[];
  return Number(rows[0]?.n ?? 0);
}

/** Resolve a buyer subject: customers row by id OR by E.164 phone. */
export async function resolveBuyerSubject(
  db: DbHandle,
  tenantId: string,
  subjectIdOrPhone: string,
): Promise<{ id: string; phone: string; createdAt: Date | null } | null> {
  const byId = (await db
    .select({ id: customers.id, phone: customers.whatsappPhone, createdAt: customers.createdAt })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, subjectIdOrPhone)))
    .limit(1)) as unknown as { id: string; phone: string; createdAt: Date | null }[];
  if (byId[0]) return byId[0];
  const norm = subjectIdOrPhone.replace(/[^\d+]/g, "");
  const byPhone = (await db
    .select({ id: customers.id, phone: customers.whatsappPhone, createdAt: customers.createdAt })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, subjectIdOrPhone)))
    .limit(1)) as unknown as { id: string; phone: string; createdAt: Date | null }[];
  if (byPhone[0]) return byPhone[0];
  if (norm && norm !== subjectIdOrPhone) {
    const loose = (await db
      .select({ id: customers.id, phone: customers.whatsappPhone, createdAt: customers.createdAt })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), sql`regexp_replace(${customers.whatsappPhone}, '[^0-9]', '', 'g') = ${norm.replace(/\D/g, "")}`))
      .limit(1)) as unknown as { id: string; phone: string; createdAt: Date | null }[];
    if (loose[0]) return loose[0];
  }
  return null;
}

/** Buyer installment repayment outcomes from plan schedules (integer math). */
function installmentOutcomes(plans: { status: string; schedule: unknown }[]): {
  onTime: number; late: number; defaulted: number;
} {
  let onTime = 0, late = 0, defaulted = 0;
  for (const p of plans) {
    if (p.status === "defaulted") defaulted += 1;
    const entries = Array.isArray(p.schedule) ? (p.schedule as any[]) : [];
    for (const e of entries) {
      if (e?.status === "paid" && e?.paidAt && e?.dueAt) {
        if (new Date(e.paidAt).getTime() <= new Date(e.dueAt).getTime()) onTime += 1;
        else late += 1;
      }
    }
  }
  return { onTime, late, defaulted };
}

/**
 * Gather trailing-90d signals for a subject from real platform tables and
 * score them deterministically. Buyer subjectId is the customers.id; a
 * merchant subjectId is the merchant's tenant id. Upserts the cache row and
 * returns the result.
 */
export async function computeAndStoreSubjectScore(
  db: DbHandle,
  tenantId: string,
  subjectType: SubjectType,
  subjectId: string,
  opts: { now?: Date; persist?: boolean } = {},
): Promise<SubjectScoreResult | null> {
  const now = opts.now ?? new Date();
  const windowStart = new Date(now.getTime() - SCORING_WINDOW_DAYS * 24 * 3600 * 1000);
  const inWindow = gte(orders.createdAt, windowStart);

  let signals: SubjectScoreSignals;

  if (subjectType === "buyer") {
    const buyer = await resolveBuyerSubject(db, tenantId, subjectId);
    if (!buyer) return null;
    const cid = buyer.id;
    const phone = buyer.phone;
    const [
      orderCount, volumeRows, recentRows,
      plans, arRows,
      disputeCount, chargebackCount, kycRow,
    ] = await Promise.all([
      countWhere(db, orders, and(eq(orders.tenantId, tenantId), eq(orders.customerId, cid), inWindow)),
      db.select({ total: sql<string>`coalesce(sum(${orders.totalAmount}), 0)` })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, cid), inWindow, eq(orders.status, "delivered"))),
      db.select({ last: sql<string>`max(${orders.createdAt})` })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, cid), inWindow)),
      db.select({ status: buyerInstallmentPlans.status, schedule: buyerInstallmentPlans.schedule })
        .from(buyerInstallmentPlans)
        .where(and(eq(buyerInstallmentPlans.tenantId, tenantId), eq(buyerInstallmentPlans.buyerPhone, phone))),
      db.select({ status: arInvoices.status, dueDate: arInvoices.dueDate, paidAt: arInvoices.paidAt })
        .from(arInvoices)
        .where(and(eq(arInvoices.tenantId, tenantId), eq(arInvoices.customerPhone, phone))),
      countWhere(db, escrowDisputes, and(
        eq(escrowDisputes.tenantId, tenantId), eq(escrowDisputes.raisedBy, "buyer"),
        sql`${escrowDisputes.orderId} in (select "id" from "orders" where "tenantId" = ${tenantId} and "customerId" = ${cid})`,
      )),
      countWhere(db, paymentDisputes, and(
        eq(paymentDisputes.tenantId, tenantId), eq(paymentDisputes.kind, "chargeback"),
        sql`${paymentDisputes.orderId} in (select "id" from "orders" where "tenantId" = ${tenantId} and "customerId" = ${cid})`,
      )),
      db.select({ status: kycApplications.status }).from(kycApplications)
        .where(and(eq(kycApplications.tenantId, tenantId), eq(kycApplications.type, "kyc"), sql`${kycApplications.applicantEmail} = ${phone} or ${kycApplications.id} = ${cid}`))
        .limit(1),
    ]);

    const inst = installmentOutcomes(plans as any);
    let arOnTime = 0, arLate = 0, arDefaulted = 0;
    for (const inv of arRows as any[]) {
      if (inv.status === "paid" && inv.paidAt) {
        if (inv.dueDate && new Date(inv.paidAt).getTime() > new Date(inv.dueDate).getTime()) arLate += 1;
        else arOnTime += 1;
      } else if (inv.status === "overdue") arDefaulted += 1;
    }

    const totalAmountStr = (volumeRows as unknown as { total: string }[])[0]?.total ?? "0";
    const salesVolumeCents = toMinorUnitsExact(totalAmountStr === "0" ? "0" : totalAmountStr);
    const lastOrder = (recentRows as unknown as { last: string | null }[])[0]?.last ?? null;
    const daysSinceLastOrder = lastOrder
      ? Math.max(0, Math.floor((now.getTime() - new Date(lastOrder).getTime()) / (24 * 3600 * 1000)))
      : null;
    const tenureDays = buyer.createdAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(buyer.createdAt).getTime()) / (24 * 3600 * 1000)))
      : 0;

    signals = {
      orderCount,
      salesVolumeCents,
      daysSinceLastOrder,
      repaymentOnTime: inst.onTime + arOnTime,
      repaymentLate: inst.late + arLate,
      repaymentDefaulted: inst.defaulted + arDefaulted,
      disputeCount,
      chargebackCount,
      kycStatus: (kycRow as any[])[0]?.status ?? null,
      tenureDays,
    };
    subjectId = cid; // canonicalise phone → customer id
  } else {
    // merchant: subjectId is the merchant tenant id
    const m = subjectId;
    const [
      orderCount, volumeRows, recentRows,
      loans,
      disputeCount, chargebackCount, refundCount, kycRow, tenantRow,
    ] = await Promise.all([
      countWhere(db, orders, and(eq(orders.tenantId, m), inWindow)),
      db.select({ total: sql<string>`coalesce(sum(${orders.totalAmount}), 0)` })
        .from(orders)
        .where(and(eq(orders.tenantId, m), inWindow, eq(orders.status, "delivered"))),
      db.select({ last: sql<string>`max(${orders.createdAt})` })
        .from(orders).where(and(eq(orders.tenantId, m), inWindow)),
      db.select({ status: merchantLoans.status }).from(merchantLoans)
        .where(eq(merchantLoans.tenantId, m)),
      countWhere(db, escrowDisputes, and(eq(escrowDisputes.tenantId, m), eq(escrowDisputes.raisedBy, "buyer"))),
      countWhere(db, paymentDisputes, and(eq(paymentDisputes.tenantId, m), eq(paymentDisputes.kind, "chargeback"))),
      countWhere(db, refunds, eq(refunds.tenantId, m)),
      db.select({ status: kycApplications.status }).from(kycApplications)
        .where(and(eq(kycApplications.tenantId, m), eq(kycApplications.type, "kyb")))
        .limit(1),
      db.select({ createdAt: tenants.createdAt }).from(tenants).where(eq(tenants.id, m)).limit(1),
    ]);

    let loanOnTime = 0, loanDefaulted = 0;
    for (const l of loans as any[]) {
      if (l.status === "repaid") loanOnTime += 1;
      else if (l.status === "defaulted") loanDefaulted += 1;
    }

    const totalAmountStr = (volumeRows as unknown as { total: string }[])[0]?.total ?? "0";
    const salesVolumeCents = toMinorUnitsExact(totalAmountStr === "0" ? "0" : totalAmountStr);
    const lastOrder = (recentRows as unknown as { last: string | null }[])[0]?.last ?? null;
    const daysSinceLastOrder = lastOrder
      ? Math.max(0, Math.floor((now.getTime() - new Date(lastOrder).getTime()) / (24 * 3600 * 1000)))
      : null;
    const createdAt = (tenantRow as any[])[0]?.createdAt ?? null;
    const tenureDays = createdAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / (24 * 3600 * 1000)))
      : 0;

    signals = {
      orderCount,
      salesVolumeCents,
      daysSinceLastOrder,
      repaymentOnTime: loanOnTime,
      repaymentLate: 0,
      repaymentDefaulted: loanDefaulted,
      disputeCount: disputeCount + refundCount,
      chargebackCount,
      kycStatus: (kycRow as any[])[0]?.status ?? null,
      tenureDays,
    };
  }

  const { score, grade, factors } = computeSubjectScore(signals);

  if (opts.persist !== false) {
    await db
      .insert(creditScores)
      .values({ tenantId, subjectType, subjectId, score, grade, factors, computedAt: now, version: SCORE_VERSION })
      .onConflictDoUpdate({
        target: [creditScores.tenantId, creditScores.subjectType, creditScores.subjectId],
        set: { score, grade, factors, computedAt: now, version: SCORE_VERSION, updatedAt: now },
      });
  }

  return { score, grade, factors, version: SCORE_VERSION, computedAt: now };
}

/** Read the cached score row (no recompute). */
export async function getStoredSubjectScore(
  db: DbHandle, tenantId: string, subjectType: SubjectType, subjectId: string,
) {
  const rows = (await db
    .select()
    .from(creditScores)
    .where(and(
      eq(creditScores.tenantId, tenantId),
      eq(creditScores.subjectType, subjectType),
      eq(creditScores.subjectId, subjectId),
    ))
    .limit(1)) as unknown as (typeof creditScores.$inferSelect)[];
  return rows[0] ?? null;
}

// ── Post-commit seam (payment settlement / refund events) ──────────────────

/**
 * Post-commit recompute seam: call AFTER a payment settlement or refund tx
 * commits (receipt-send pattern — additive, non-blocking). NEVER throws;
 * failures are logged as telemetry only. Scoring must never break checkout.
 */
export async function recomputeAfterPaymentEvent(
  db: DbHandle,
  evt: { tenantId: string; buyerSubjectId?: string | null; merchantId?: string | null; kind: "settlement" | "refund" },
): Promise<void> {
  try {
    if (evt.buyerSubjectId) {
      await computeAndStoreSubjectScore(db, evt.tenantId, "buyer", evt.buyerSubjectId);
    }
    if (evt.merchantId) {
      await computeAndStoreSubjectScore(db, evt.tenantId, "merchant", evt.merchantId);
    }
  } catch (e: any) {
    try {
      process.stdout.write(JSON.stringify({
        level: "warn", metric: "credit_score_recompute_failed",
        tenantId: evt.tenantId, kind: evt.kind, error: String(e?.message ?? e),
      }) + "\n");
    } catch { /* telemetry must never break the money path */ }
  }
}

// ── Scheduled sweep ─────────────────────────────────────────────────────────

export interface CreditScoreSweepResult {
  tenantsScanned: number;
  recomputed: number;
  failed: number;
}

/**
 * Scheduled refresh sweep (GET/POST /api/scheduled/credit-score-refresh):
 * recomputes rows whose computedAt is older than STALE_AFTER_HOURS, bounded
 * per run (PGlite-safe sequential batches). Deterministic ordering by
 * updatedAt ASC so the stalest rows are refreshed first.
 */
export async function runCreditScoreRefreshSweep(
  db: DbHandle,
  opts: { now?: Date; limit?: number } = {},
): Promise<CreditScoreSweepResult> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const staleBefore = new Date(now.getTime() - STALE_AFTER_HOURS * 3600 * 1000);

  const stale = (await db
    .select({
      tenantId: creditScores.tenantId,
      subjectType: creditScores.subjectType,
      subjectId: creditScores.subjectId,
    })
    .from(creditScores)
    // PGlite binds can't serialize Date — ISO string (repo convention).
    .where(sql`${creditScores.computedAt} < ${staleBefore.toISOString()}`)
    .orderBy(creditScores.computedAt)
    .limit(limit)) as unknown as { tenantId: string; subjectType: SubjectType; subjectId: string }[];

  let recomputed = 0, failed = 0;
  const tenantsSeen = new Set<string>();
  for (const row of stale) {
    tenantsSeen.add(row.tenantId);
    try {
      const r = await computeAndStoreSubjectScore(db, row.tenantId, row.subjectType, row.subjectId, { now });
      if (r) recomputed += 1;
      else failed += 1; // subject disappeared — honest failure count, row retained
    } catch {
      failed += 1;
    }
  }
  return { tenantsScanned: tenantsSeen.size, recomputed, failed };
}
