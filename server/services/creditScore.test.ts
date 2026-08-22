/**
 * W27 credit — unit tests for the deterministic scoring core
 * (computeScoreFromSignals) and helpers. No db: signals are supplied
 * directly; identical inputs must yield identical scores (J138 contract).
 */
import { describe, it, expect } from "vitest";
import {
  computeScoreFromSignals,
  pctInt,
  VOLUME_SATURATION_ORDERS,
  TENURE_SATURATION_DAYS,
  type MerchantScoreSignals,
} from "./creditScore";

function signals(over: Partial<MerchantScoreSignals> = {}): MerchantScoreSignals {
  return {
    totalOrders: 0,
    completedOrders: 0,
    cancelledOrders: 0,
    refundedOrders: 0,
    pendingOrders: 0,
    salesVolumeCents: 0,
    codOrdersTotal: 0,
    codCollected: 0,
    codFailed: 0,
    paymentsCompleted: 0,
    paymentsFailed: 0,
    refundCount: 0,
    buyerDisputeCount: 0,
    tenureDays: 0,
    trustScore: null,
    ...over,
  };
}

describe("pctInt", () => {
  it("computes integer percents with round-half-up", () => {
    expect(pctInt(1, 2)).toBe(50);
    expect(pctInt(1, 3)).toBe(33);
    expect(pctInt(2, 3)).toBe(67);
    expect(pctInt(0, 5)).toBe(0);
    expect(pctInt(5, 0)).toBe(0);
  });
});

describe("computeScoreFromSignals", () => {
  it("is deterministic: same signals → same score and factors", () => {
    const s = signals({
      totalOrders: 40, completedOrders: 36, cancelledOrders: 2, refundedOrders: 2,
      salesVolumeCents: 12_345_600,
      codOrdersTotal: 10, codCollected: 9, codFailed: 1,
      paymentsCompleted: 25, paymentsFailed: 1,
      refundCount: 2, buyerDisputeCount: 0,
      tenureDays: 200, trustScore: 80,
    });
    const a = computeScoreFromSignals(s);
    const b = computeScoreFromSignals({ ...s });
    expect(a.score).toBe(b.score);
    expect(a.factors).toEqual(b.factors);
    expect(Number.isInteger(a.score)).toBe(true);
  });

  it("gives a brand-new merchant the documented cold-start score", () => {
    const { score, factors } = computeScoreFromSignals(signals());
    // cold-start: 0 (volume) + 75 + 75 + 75 + 150 (no adverse events) + 0 (tenure) + 50 (trust)
    expect(score).toBe(425);
    expect(factors.completionRate.ratePct).toBeNull();
    expect(factors.codCollectionRate.ratePct).toBeNull();
    expect(factors.paymentSuccessRate.ratePct).toBeNull();
    expect(factors.refundDisputeRate.points).toBe(150);
  });

  it("saturates order volume at 50 completed orders for full 200 points", () => {
    const at = computeScoreFromSignals(signals({ completedOrders: VOLUME_SATURATION_ORDERS }));
    const over = computeScoreFromSignals(signals({ completedOrders: 500 }));
    expect(at.factors.orderVolume.points).toBe(200);
    expect(over.factors.orderVolume.points).toBe(200);
  });

  it("saturates tenure at 365 days", () => {
    const { factors } = computeScoreFromSignals(signals({ tenureDays: TENURE_SATURATION_DAYS * 3 }));
    expect(factors.tenure.points).toBe(100);
    expect(factors.tenure.days).toBe(TENURE_SATURATION_DAYS * 3);
  });

  it("a 20% adverse rate zeroes the refund/dispute factor", () => {
    const { factors } = computeScoreFromSignals(
      signals({ totalOrders: 20, refundCount: 3, buyerDisputeCount: 1 }), // 20%
    );
    expect(factors.refundDisputeRate.ratePct).toBe(20);
    expect(factors.refundDisputeRate.points).toBe(0);
  });

  it("clamps trustScore to 0-100 and scores it proportionally", () => {
    const hi = computeScoreFromSignals(signals({ trustScore: 250 }));
    expect(hi.factors.trustScore.trustScore).toBe(100);
    expect(hi.factors.trustScore.points).toBe(100);
    const half = computeScoreFromSignals(signals({ trustScore: 50 }));
    expect(half.factors.trustScore.points).toBe(50);
  });

  it("never exceeds [0, 1000] and rewards a perfect merchant with ~1000", () => {
    const { score } = computeScoreFromSignals(signals({
      totalOrders: 100, completedOrders: 100,
      codOrdersTotal: 20, codCollected: 20,
      paymentsCompleted: 80,
      tenureDays: 1000, trustScore: 100,
    }));
    expect(score).toBe(1000);
    const floor = computeScoreFromSignals(signals({
      totalOrders: 50, cancelledOrders: 50,
      codOrdersTotal: 10, codFailed: 10,
      paymentsFailed: 40, refundCount: 50, trustScore: 0,
    }));
    expect(floor.score).toBe(0);
  });

  it("exposes the 90d sales volume signal in integer cents for loan sizing", () => {
    const { factors } = computeScoreFromSignals(signals({ salesVolumeCents: 9_876_543 }));
    expect(factors.salesVolumeCents90d).toBe(9_876_543);
  });
});
