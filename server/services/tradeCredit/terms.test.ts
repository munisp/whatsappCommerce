/**
 * W18 risk-based terms — score → tenor/fee band mapping.
 */
import { describe, it, expect } from "vitest";
import { termsForScore, TERMS_BANDS } from "./terms";

describe("termsForScore", () => {
  it("maps every band boundary exactly", () => {
    expect(termsForScore(100)).toEqual({ tenorDays: 45, feeBps: 0, decline: false });
    expect(termsForScore(80)).toEqual({ tenorDays: 45, feeBps: 0, decline: false });
    expect(termsForScore(79)).toEqual({ tenorDays: 30, feeBps: 150, decline: false });
    expect(termsForScore(60)).toEqual({ tenorDays: 30, feeBps: 150, decline: false });
    expect(termsForScore(59)).toEqual({ tenorDays: 21, feeBps: 250, decline: false });
    expect(termsForScore(40)).toEqual({ tenorDays: 21, feeBps: 250, decline: false });
    expect(termsForScore(39)).toEqual({ tenorDays: 14, feeBps: 350, decline: false });
    expect(termsForScore(20)).toEqual({ tenorDays: 14, feeBps: 350, decline: false });
    expect(termsForScore(19)).toEqual({ tenorDays: 0, feeBps: 0, decline: true });
    expect(termsForScore(0)).toEqual({ tenorDays: 0, feeBps: 0, decline: true });
  });

  it("bands are ordered and cover 0..100 without gaps", () => {
    expect(TERMS_BANDS.map((b) => b.minScore)).toEqual([80, 60, 40, 20, 0]);
    for (let s = 0; s <= 100; s++) {
      const t = termsForScore(s);
      if (s < 20) expect(t.decline).toBe(true);
      else expect(t.decline).toBe(false);
    }
  });

  it("higher scores never get worse terms (monotone over non-decline bands)", () => {
    let prev = termsForScore(20);
    for (let s = 21; s <= 100; s++) {
      const cur = termsForScore(s);
      expect(cur.tenorDays).toBeGreaterThanOrEqual(prev.tenorDays);
      expect(cur.feeBps).toBeLessThanOrEqual(prev.feeBps);
      prev = cur;
    }
  });

  it("clamps out-of-range input", () => {
    expect(termsForScore(-5)).toEqual(termsForScore(0));
    expect(termsForScore(150)).toEqual(termsForScore(100));
  });
});
