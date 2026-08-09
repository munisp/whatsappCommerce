/**
 * Credit scoring — deterministic, unit-testable limit suggestions.
 *
 * Inputs (platform history, buyer side):
 *   - 30-day order volume: the buyer tenant's own order GMV over the
 *     trailing 30 days (orders.totalAmount, decimal major units → cents) —
 *     a proxy for repayment capacity.
 *   - Tenure: whole months since the buyer tenant's first order (0 when no
 *     orders yet).
 *   - Payment timeliness: share of the buyer's completed payment_transactions
 *     paid within 24h of initiation (paidAt - createdAt <= 24h).
 *
 * Formula (deterministic — no randomness, no external calls):
 *   onTime       = on-time rate of completed payments; 0.5 when no completed
 *                  payments exist (neutral prior).
 *   volumeFactor = min(1, vol30dCents / VOLUME_TARGET_CENTS)   // ₦5M target
 *   tenureFactor = min(1, tenureMonths / 12)                   // 1y = full
 *   score        = round(100 * (0.5*onTime + 0.3*volumeFactor + 0.2*tenureFactor))
 *                  clamped to 0..100.
 *
 *   Cold start (no orders AND no payments): score = COLD_START_SCORE (10),
 *   suggestedLimitCents = FLOOR_LIMIT_CENTS (₦50k) — conservative floor.
 *
 *   Otherwise:
 *   suggestedLimitCents = clamp(
 *       round(vol30dCents * (0.2 + 0.8 * score/100) / 1000) * 1000,
 *       FLOOR_LIMIT_CENTS, CAP_LIMIT_CENTS)                    // ₦50k..₦50M
 *   i.e. a facility sized between 20% and 100% of a month's volume, scaled
 *   by trust (score), rounded to whole ₦10 (1000 cents).
 *
 * `supplierTenantId` is part of the signature for future per-supplier
 * weighting; scoring today is platform-wide (documented so callers do not
 * assume otherwise).
 */
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { orders, paymentTransactions } from "../../../drizzle/schema";
import type { TxHandle } from "./accounts";

export const VOLUME_TARGET_CENTS = 500_000_000; // ₦5,000,000
export const FLOOR_LIMIT_CENTS = 5_000_000; // ₦50,000
export const CAP_LIMIT_CENTS = 5_000_000_000; // ₦50,000,000
export const COLD_START_SCORE = 10;
export const ON_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CreditScoreResult {
  score: number;
  suggestedLimitCents: number;
  reasons: string[];
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

export async function suggestLimitTx(
  db: TxHandle,
  buyerTenantId: string,
  _supplierTenantId: string,
  now: Date = new Date(),
): Promise<CreditScoreResult> {
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // 30-day order volume (buyer tenant's own GMV).
  const recentOrders = await db
    .select({ totalAmount: orders.totalAmount })
    .from(orders)
    .where(and(eq(orders.tenantId, buyerTenantId), gte(orders.createdAt, since30d)))
    .orderBy(desc(orders.createdAt));
  const vol30dCents = recentOrders.reduce(
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

  // ── Formula ──────────────────────────────────────────────────────────────
  const coldStart = recentOrders.length === 0 && !firstOrder && !hasPayments;
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
    const volumeFactor = Math.min(1, vol30dCents / VOLUME_TARGET_CENTS);
    const tenureFactor = Math.min(1, tenureMonths / 12);
    score = Math.max(0, Math.min(100, Math.round(100 * (0.5 * onTime + 0.3 * volumeFactor + 0.2 * tenureFactor))));
    const raw = vol30dCents * (0.2 + 0.8 * (score / 100));
    suggestedLimitCents = Math.max(FLOOR_LIMIT_CENTS, Math.min(CAP_LIMIT_CENTS, Math.round(raw / 1000) * 1000));
    reasons.push(
      hasPayments
        ? `on-time rate ${Math.round(onTime * 100)}%`
        : "no completed payments — neutral on-time prior",
    );
    reasons.push(`${formatNairaCompact(vol30dCents)} 30-day volume`);
    reasons.push(`${tenureMonths} months tenure`);
  }

  return { score, suggestedLimitCents, reasons };
}
