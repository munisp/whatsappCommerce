/**
 * W22 banditLimits unit tests — pure-math and policy guarantees of the
 * LinUCB contextual bandit (DB integration is covered by journey J100).
 *
 * Proves:
 *   1. context normalization + determinism
 *   2. invertMatrix correctness / singularity handling
 *   3. chooseArm determinism (fixed-seed tie-breaking) and exploitation:
 *      the historically-rewarding multiplier wins when evidence is balanced
 *   4. applyMultiplier: integer cents, ₦10 rounding, FLOOR/CAP envelope and
 *      the program cap-clamp proof (×1.5 never exceeds maxExposure /
 *      remainingCapacity)
 *   5. banditMode env parsing (active only on the exact string)
 */
import { describe, expect, it } from "vitest";
import {
  applyMultiplier,
  BANDIT_PARAMS,
  banditContext,
  BANDIT_CONTEXT_DIM,
  banditMode,
  chooseArm,
  invertMatrix,
  mulberry32,
} from "./banditLimits";
import { CAP_LIMIT_CENTS, FLOOR_LIMIT_CENTS } from "./tradeCredit/scoring";

const CTX = banditContext({ pd: 0.2, utilization: 0.5, tenureDays: 180, volume90dCents: 100_000_000 });

describe("banditContext", () => {
  it("normalizes features into [0,1] with a leading bias term", () => {
    expect(CTX).toHaveLength(BANDIT_CONTEXT_DIM);
    expect(CTX[0]).toBe(1);
    expect(CTX[1]).toBeCloseTo(0.2);
    expect(CTX[2]).toBeCloseTo(0.5);
    expect(CTX[3]).toBeCloseTo(180 / 365);
    for (const v of CTX) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("clamps out-of-range inputs and non-finite PD", () => {
    const c = banditContext({ pd: Number.NaN, utilization: 7, tenureDays: 99999, volume90dCents: -5 });
    expect(c[1]).toBe(0.5);
    expect(c[2]).toBe(1);
    expect(c[3]).toBe(1);
    expect(c[4]).toBe(0);
  });
});

describe("invertMatrix", () => {
  it("inverts a small matrix (A·A⁻¹ ≈ I)", () => {
    const a = [[4, 1, 0.5], [1, 3, 0.25], [0.5, 0.25, 2]];
    const inv = invertMatrix(a)!;
    expect(inv).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = a[i].reduce((s, v, k) => s + v * inv[k][j], 0);
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });

  it("returns null for a singular matrix", () => {
    expect(invertMatrix([[1, 2], [2, 4]])).toBeNull();
  });
});

describe("chooseArm", () => {
  it("is deterministic: identical rows + context → identical arm and scores", () => {
    const rows = [
      { context: CTX, chosenMultiplier: 1.0, reward: 1 },
      { context: CTX, chosenMultiplier: 1.25, reward: 0.5 },
      { context: CTX, chosenMultiplier: 1.5, reward: 0 },
    ];
    const a = chooseArm(rows, CTX);
    const b = chooseArm(rows, CTX);
    expect(a.armIndex).toBe(b.armIndex);
    expect(a.scores).toEqual(b.scores);
    expect(BANDIT_PARAMS.multipliers[a.armIndex]).toBe(a.multiplier);
  });

  it("cold start: no evidence → deterministic seeded tie-break", () => {
    const a = chooseArm([], CTX);
    const b = chooseArm([], CTX);
    expect(a.armIndex).toBe(b.armIndex);
    // Every arm scored identically (ridge prior) — the tie-break picked one.
    expect(new Set(a.scores.map((s) => s.toPrecision(12))).size).toBe(1);
  });

  it("exploits the historically-rewarding multiplier", () => {
    const rows: Array<{ context: number[]; chosenMultiplier: number; reward: number }> = [];
    // Balanced evidence per arm: ×0.75 always defaults, ×1.5 always repays.
    for (let i = 0; i < 20; i++) {
      const ctx = banditContext({ pd: 0.1 + 0.02 * i, utilization: 0.4, tenureDays: 100 + i, volume90dCents: 50_000_000 });
      rows.push({ context: ctx, chosenMultiplier: 0.75, reward: 0 });
      rows.push({ context: ctx, chosenMultiplier: 1.0, reward: 0.5 });
      rows.push({ context: ctx, chosenMultiplier: 1.25, reward: 0.5 });
      rows.push({ context: ctx, chosenMultiplier: 1.5, reward: 1 });
    }
    const choice = chooseArm(rows, CTX);
    expect(choice.multiplier).toBe(1.5);
  });

  it("handles malformed/short contexts without throwing", () => {
    expect(() => chooseArm([{ context: [1], chosenMultiplier: 1, reward: 1 }], [1, 0.5])).not.toThrow();
  });
});

describe("applyMultiplier", () => {
  it("integer cents, rounded to whole ₦10, inside the FLOOR/CAP envelope", () => {
    const v = applyMultiplier(10_000_123, 1.25);
    expect(Number.isInteger(v)).toBe(true);
    expect(v % 1000).toBe(0);
    expect(v).toBe(12_500_000);
    expect(applyMultiplier(1, 0.75)).toBe(FLOOR_LIMIT_CENTS);
    expect(applyMultiplier(CAP_LIMIT_CENTS, 1.5)).toBe(CAP_LIMIT_CENTS);
  });

  it("cap-clamp proof: ×1.5 never exceeds maxExposure / remainingCapacity", () => {
    const baseline = 100_000_000;
    const capped = applyMultiplier(baseline, 1.5, { maxExposureCents: 120_000_000 });
    expect(capped).toBeLessThanOrEqual(120_000_000);
    const capped2 = applyMultiplier(baseline, 1.5, {
      maxExposureCents: 200_000_000,
      remainingCapacityCents: 90_000_000,
    });
    expect(capped2).toBeLessThanOrEqual(90_000_000);
    // Zero remaining capacity → zero (hard constraint overrides the floor).
    expect(applyMultiplier(baseline, 1.5, { remainingCapacityCents: 0 })).toBe(0);
  });
});

describe("banditMode", () => {
  it("parses the env flag exactly", () => {
    expect(banditMode({} as NodeJS.ProcessEnv)).toBe("shadow");
    expect(banditMode({ BANDIT_LIMITS_MODE: "active" } as NodeJS.ProcessEnv)).toBe("active");
    expect(banditMode({ BANDIT_LIMITS_MODE: "ACTIVE" } as NodeJS.ProcessEnv)).toBe("active");
    expect(banditMode({ BANDIT_LIMITS_MODE: "shadow" } as NodeJS.ProcessEnv)).toBe("shadow");
    expect(banditMode({ BANDIT_LIMITS_MODE: "1" } as NodeJS.ProcessEnv)).toBe("shadow");
  });
});

describe("mulberry32", () => {
  it("is a fixed-seed deterministic PRNG in [0,1)", () => {
    const a = mulberry32(BANDIT_PARAMS.seed);
    const b = mulberry32(BANDIT_PARAMS.seed);
    for (let i = 0; i < 10; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
