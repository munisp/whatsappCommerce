/**
 * server/feeInvariant.test.ts — escrow fee split conservation invariant.
 *
 * Property test for splitEscrowAmounts (shared/escrowAmounts.ts): the old
 * float split (fee = amount * rate, net = amount - fee, each toFixed(2))
 * violated fee + net == amount for ~2% of amounts because fee and net were
 * rounded independently (rate is numeric(6,4), e.g. 0.03125). The integer
 * minor-units split rounds the fee ONCE and derives net = gross - fee, so the
 * invariant holds for EVERY amount.
 */
import { describe, it, expect } from "vitest";
import { splitEscrowAmounts, toMinorUnitsExact, minorUnitsToString } from "../shared/escrowAmounts";

// Deterministic PRNG (mulberry32) so failures reproduce exactly.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATES = ["0.03125", "0.025", "0.015", "0.05", "0.1", "0.001"];

describe("splitEscrowAmounts — fee + net == gross for ALL amounts", () => {
  it("property: 200 random amounts in kobo conserve the gross under every rate", () => {
    const rand = mulberry32(0xC0FFEE);
    for (let i = 0; i < 200; i++) {
      // Random gross between 1 kobo and ~10,000,000.00 NGN (1e9 kobo).
      const grossMinor = 1 + Math.floor(rand() * 1_000_000_000);
      const rate = RATES[Math.floor(rand() * RATES.length)];
      const split = splitEscrowAmounts(grossMinor / 100, rate);

      expect(split.feeMinor + split.netMinor, `gross=${grossMinor} rate=${rate}`).toBe(grossMinor);
      expect(split.grossMinor, `gross=${grossMinor} rate=${rate}`).toBe(grossMinor);
      expect(split.feeMinor).toBeGreaterThanOrEqual(0);
      expect(split.netMinor).toBeGreaterThanOrEqual(0);
      expect(split.feeMinor).toBeLessThanOrEqual(grossMinor);
      // Decimal strings must parse back to the same minor units.
      expect(toMinorUnitsExact(split.fee)).toBe(split.feeMinor);
      expect(toMinorUnitsExact(split.net)).toBe(split.netMinor);
      expect(toMinorUnitsExact(split.gross)).toBe(grossMinor);
    }
  });

  it("property: string decimal inputs conserve exactly like numeric inputs", () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const grossMinor = 1 + Math.floor(rand() * 100_000_000);
      const grossStr = minorUnitsToString(grossMinor);
      const split = splitEscrowAmounts(grossStr, "0.03125");
      expect(split.feeMinor + split.netMinor).toBe(grossMinor);
    }
  });

  it("rounds the fee half-up at a single point and derives net by subtraction", () => {
    // 1000.00 NGN @ 3.125% → fee 31.25 exactly, net 968.75.
    const s1 = splitEscrowAmounts("1000.00", "0.03125");
    expect(s1.fee).toBe("31.25");
    expect(s1.net).toBe("968.75");
    expect(s1.feeMinor + s1.netMinor).toBe(100_000);

    // 0.01 NGN (1 kobo) @ 3.125% → fee rounds to 0, net keeps the kobo.
    const s2 = splitEscrowAmounts("0.01", "0.03125");
    expect(s2.feeMinor + s2.netMinor).toBe(1);
    expect(s2.feeMinor).toBe(0);
    expect(s2.netMinor).toBe(1);

    // Half-kobo fee boundary: 0.16 NGN (16 kobo) @ 3.125% = 0.5 kobo → rounds
    // half up to 1 kobo; net = 15 kobo; conservation holds.
    const s3 = splitEscrowAmounts("0.16", "0.03125");
    expect(s3.feeMinor).toBe(1);
    expect(s3.netMinor).toBe(15);
    expect(s3.feeMinor + s3.netMinor).toBe(16);
  });

  it("demonstrates the OLD float split would have violated the invariant", () => {
    // Reference implementation of the pre-fix behavior.
    const rand = mulberry32(7);
    let oldViolations = 0;
    let newViolations = 0;
    for (let i = 0; i < 200; i++) {
      const grossMinor = 1 + Math.floor(rand() * 100_000_000);
      const gross = grossMinor / 100;
      const rate = 0.03125;
      const oldFee = parseFloat((gross * rate).toFixed(2));
      const oldNet = parseFloat((gross - gross * rate).toFixed(2));
      if (Math.round(oldFee * 100) + Math.round(oldNet * 100) !== grossMinor) oldViolations++;
      const s = splitEscrowAmounts(gross, rate);
      if (s.feeMinor + s.netMinor !== grossMinor) newViolations++;
    }
    expect(oldViolations, "the old float split must exhibit the bug on this corpus").toBeGreaterThan(0);
    expect(newViolations).toBe(0);
  });

  it("rejects invalid rates and amounts", () => {
    expect(() => splitEscrowAmounts(100, -0.1)).toThrow();
    expect(() => splitEscrowAmounts(100, 1)).toThrow();
    expect(() => splitEscrowAmounts("abc", 0.03)).toThrow();
    expect(() => splitEscrowAmounts(-5, 0.03)).toThrow();
  });
});

describe("minor-units conversions", () => {
  it("toMinorUnitsExact rounds half-up at kobo granularity", () => {
    expect(toMinorUnitsExact(19.99)).toBe(1999);
    expect(toMinorUnitsExact("19.99")).toBe(1999);
    expect(toMinorUnitsExact("0.01")).toBe(1);
    expect(toMinorUnitsExact("1234.567")).toBe(123457); // 3rd decimal 7 rounds up
    expect(toMinorUnitsExact("1234.564")).toBe(123456); // 3rd decimal 4 rounds down
    expect(toMinorUnitsExact(0)).toBe(0);
  });

  it("minorUnitsToString formats two decimals", () => {
    expect(minorUnitsToString(0)).toBe("0.00");
    expect(minorUnitsToString(1)).toBe("0.01");
    expect(minorUnitsToString(1999)).toBe("19.99");
    expect(minorUnitsToString(100000)).toBe("1000.00");
  });
});
