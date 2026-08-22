/**
 * W27 loyalty unit tests — pure rule math: earn computation, redemption
 * caps, and the trust-score formula in reviews.ts. No DB.
 */
import { describe, it, expect } from "vitest";
import {
  computeEarnPoints,
  previewRedemption,
  DEFAULT_LOYALTY_RULES,
  type LoyaltyRules,
} from "./loyalty";
import { computeReviewTrustScorePure } from "./reviews";

const rules: LoyaltyRules = {
  enabled: true,
  pointsPerUnit: 1,
  unitValueCents: 10_000, // 1 pt / ₦100
  pointsValueCents: 100, // 1 pt = ₦1
  redemptionCapPercent: 20,
};

describe("computeEarnPoints", () => {
  it("floors partial units", () => {
    expect(computeEarnPoints(rules, 550_000)).toBe(55); // ₦5,500 → 55 pts
    expect(computeEarnPoints(rules, 9_999)).toBe(0); // below one unit
    expect(computeEarnPoints(rules, 10_000)).toBe(1);
  });
  it("zero when disabled or zero total", () => {
    expect(computeEarnPoints({ ...rules, enabled: false }, 550_000)).toBe(0);
    expect(computeEarnPoints(rules, 0)).toBe(0);
  });
  it("scales with pointsPerUnit", () => {
    expect(computeEarnPoints({ ...rules, pointsPerUnit: 2 }, 100_000)).toBe(20);
  });
});

describe("previewRedemption", () => {
  it("burns up to the balance when under the cap", () => {
    // ₦5,000 order, cap 20% = ₦100 = 10,000 cents; 50 pts = ₦50 → all 50.
    const p = previewRedemption(rules, 50, 500_000);
    expect(p.points).toBe(50);
    expect(p.discountCents).toBe(5_000);
  });
  it("caps the discount at redemptionCapPercent of the order total", () => {
    // ₦3,000 order, cap 20% = ₦600; 1000 pts would be ₦1,000 → capped to ₦600.
    const p = previewRedemption(rules, 1000, 300_000);
    expect(p.capCents).toBe(60_000);
    expect(p.discountCents).toBe(60_000);
    expect(p.points).toBe(600);
  });
  it("never exceeds the order total or the balance", () => {
    expect(previewRedemption(rules, 0, 300_000).discountCents).toBe(0);
    const tiny = previewRedemption({ ...rules, redemptionCapPercent: 100 }, 10_000, 5_000);
    expect(tiny.discountCents).toBeLessThanOrEqual(5_000);
  });
  it("points value of zero yields no redemption", () => {
    const p = previewRedemption({ ...rules, pointsValueCents: 0 }, 100, 300_000);
    expect(p.points).toBe(0);
    expect(p.discountCents).toBe(0);
  });
  it("default rules match the spec example (1 pt per ₦100)", () => {
    expect(DEFAULT_LOYALTY_RULES.unitValueCents).toBe(10_000);
    expect(DEFAULT_LOYALTY_RULES.pointsPerUnit).toBe(1);
    expect(DEFAULT_LOYALTY_RULES.redemptionCapPercent).toBe(20);
  });
});

describe("computeReviewTrustScorePure", () => {
  it("is null with no published reviews", () => {
    expect(computeReviewTrustScorePure({ avgRating: 0, publishedCount: 0, removedCount: 0 })).toBeNull();
  });
  it("5★ lifts, 1★ sinks, volume adds, removals penalize", () => {
    expect(computeReviewTrustScorePure({ avgRating: 5, publishedCount: 2, removedCount: 0 })).toBe(82);
    expect(computeReviewTrustScorePure({ avgRating: 1, publishedCount: 1, removedCount: 0 })).toBe(21);
    expect(computeReviewTrustScorePure({ avgRating: 3, publishedCount: 25, removedCount: 0 })).toBe(70); // volume capped at 20
    expect(computeReviewTrustScorePure({ avgRating: 5, publishedCount: 2, removedCount: 3 })).toBe(67);
  });
  it("clamps to [0, 100]", () => {
    expect(computeReviewTrustScorePure({ avgRating: 5, publishedCount: 100, removedCount: 0 })).toBeLessThanOrEqual(100);
    expect(computeReviewTrustScorePure({ avgRating: 1, publishedCount: 1, removedCount: 20 })).toBeGreaterThanOrEqual(0);
  });
});
