// === W56 credit ===
/**
 * creditScoring pure-core tests: deterministic weighted model, grade bands,
 * cold-start rules. No db — the core takes pre-aggregated signals.
 */
import { describe, it, expect } from "vitest";
import {
  computeSubjectScore,
  gradeForScore,
  SCORE_VERSION,
  VOLUME_SATURATION_CENTS,
  type SubjectScoreSignals,
} from "./creditScoring";

function signals(over: Partial<SubjectScoreSignals> = {}): SubjectScoreSignals {
  return {
    orderCount: 0,
    salesVolumeCents: 0,
    daysSinceLastOrder: null,
    repaymentOnTime: 0,
    repaymentLate: 0,
    repaymentDefaulted: 0,
    disputeCount: 0,
    chargebackCount: 0,
    kycStatus: null,
    tenureDays: 0,
    ...over,
  };
}

describe("W56 creditScoring core", () => {
  it("is deterministic: same inputs → same score/grade/factors", () => {
    const s = signals({ orderCount: 12, salesVolumeCents: 50_000_000, daysSinceLastOrder: 3, repaymentOnTime: 4, repaymentLate: 1, kycStatus: "approved", tenureDays: 400 });
    const a = computeSubjectScore(s);
    const b = computeSubjectScore({ ...s });
    expect(a).toEqual(b);
    expect(a.score).toBeGreaterThan(0);
  });

  it("grade bands: A≥800 B≥650 C≥500 D≥350 E<350", () => {
    expect(gradeForScore(1000)).toBe("A");
    expect(gradeForScore(800)).toBe("A");
    expect(gradeForScore(799)).toBe("B");
    expect(gradeForScore(650)).toBe("B");
    expect(gradeForScore(500)).toBe("C");
    expect(gradeForScore(350)).toBe("D");
    expect(gradeForScore(349)).toBe("E");
    expect(gradeForScore(0)).toBe("E");
  });

  it("cold-start subject (no history) earns half-weight rate factors", () => {
    const r = computeSubjectScore(signals());
    // orderHistory 0, volume 0, repayment half (150), disputes full (150),
    // kyc half (50), tenure 0 → 350 → grade D.
    expect(r.score).toBe(350);
    expect(r.grade).toBe("D");
    expect(r.factors.repaymentTimeliness.ratePct).toBeNull();
  });

  it("perfect subject saturates at 1000 / A", () => {
    const r = computeSubjectScore(signals({
      orderCount: 60,
      salesVolumeCents: VOLUME_SATURATION_CENTS * 2,
      daysSinceLastOrder: 1,
      repaymentOnTime: 20,
      kycStatus: "approved",
      tenureDays: 800,
    }));
    expect(r.score).toBe(1000);
    expect(r.grade).toBe("A");
  });

  it("a default counts double in repayment timeliness", () => {
    const clean = computeSubjectScore(signals({ repaymentOnTime: 8 }));
    const withDefault = computeSubjectScore(signals({ repaymentOnTime: 8, repaymentDefaulted: 1 }));
    expect(withDefault.factors.repaymentTimeliness.points)
      .toBeLessThan(clean.factors.repaymentTimeliness.points);
    // 8/(8+2) = 80% → 240 points
    expect(withDefault.factors.repaymentTimeliness.points).toBe(240);
  });

  it("chargebacks count double in dispute history; floor at 0", () => {
    const r = computeSubjectScore(signals({ disputeCount: 1, chargebackCount: 2 }));
    // 150 - 30*(1 + 2*2) = 0
    expect(r.factors.disputeHistory.points).toBe(0);
    const capped = computeSubjectScore(signals({ disputeCount: 50 }));
    expect(capped.factors.disputeHistory.points).toBe(0);
  });

  it("kyc approved earns full weight; in-progress earns 20", () => {
    expect(computeSubjectScore(signals({ kycStatus: "approved" })).factors.kycStatus.points).toBe(100);
    expect(computeSubjectScore(signals({ kycStatus: "in_review" })).factors.kycStatus.points).toBe(20);
  });

  it("recency bands are integer-deterministic", () => {
    const at7 = computeSubjectScore(signals({ orderCount: 1, daysSinceLastOrder: 7 }));
    const at30 = computeSubjectScore(signals({ orderCount: 1, daysSinceLastOrder: 30 }));
    const at91 = computeSubjectScore(signals({ orderCount: 1, daysSinceLastOrder: 91 }));
    expect(at7.factors.orderHistory.points).toBe(4 + 80);
    expect(at30.factors.orderHistory.points).toBe(4 + 50);
    expect(at91.factors.orderHistory.points).toBe(4 + 0);
  });

  it("exposes the model version constant", () => {
    expect(SCORE_VERSION).toBe("w56-v1");
  });
});
