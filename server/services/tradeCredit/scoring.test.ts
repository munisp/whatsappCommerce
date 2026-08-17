/**
 * suggestLimit / scoring — determinism, formula factors, cold start, reasons.
 */
import { describe, it, expect } from "vitest";
import {
  suggestLimitTx,
  formatNairaCompact,
  FLOOR_LIMIT_CENTS,
  CAP_LIMIT_CENTS,
  COLD_START_SCORE,
  VOLUME_TARGET_CENTS,
  SCORING_WEIGHTS,
  creditFactorFromSignals,
} from "./scoring";
import { makeFakeDb, seedAccount, seedDraw } from "./fakeDb";

const NOW = new Date("2025-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5);

describe("formatNairaCompact", () => {
  it("formats millions, thousands and small amounts", () => {
    expect(formatNairaCompact(240_000_000)).toBe("₦2.4M");
    expect(formatNairaCompact(500_000_000)).toBe("₦5M");
    expect(formatNairaCompact(85_000_000)).toBe("₦850k");
    expect(formatNairaCompact(1_200_000)).toBe("₦12,000");
    expect(formatNairaCompact(0)).toBe("₦0");
  });
});

describe("suggestLimitTx", () => {
  it("cold start (no orders, no payments) → conservative floor and score", async () => {
    const { db } = makeFakeDb();
    const res = await suggestLimitTx(db, "buyer-new", "supplier-1", NOW);
    expect(res.score).toBe(COLD_START_SCORE);
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS);
    expect(res.reasons[0]).toContain("cold-start");
    expect(res.reasons).toHaveLength(3);
  });

  it("deterministic: same inputs → identical output", async () => {
    const seed = {
      orders: [
        { tenantId: "buyer-1", totalAmount: "10000.00", createdAt: daysAgo(5) },
        { tenantId: "buyer-1", totalAmount: "20000.00", createdAt: daysAgo(400) },
      ],
      payments: [
        { tenantId: "buyer-1", status: "completed", createdAt: daysAgo(10), paidAt: daysAgo(9) },
      ],
    };
    const a = await suggestLimitTx(makeFakeDb(seed).db, "buyer-1", "supplier-1", NOW);
    const b = await suggestLimitTx(makeFakeDb(seed).db, "buyer-1", "supplier-1", NOW);
    expect(a).toEqual(b);
  });

  it("perfect history: 100% on-time + target volume + 12m tenure → score 100", async () => {
    const { db } = makeFakeDb({
      orders: [
        { tenantId: "buyer-1", totalAmount: "5000000.00", createdAt: daysAgo(3) }, // ₦5M in 30d
        { tenantId: "buyer-1", totalAmount: "1.00", createdAt: daysAgo(365) }, // 12m tenure
      ],
      payments: [
        { tenantId: "buyer-1", status: "completed", createdAt: daysAgo(20), paidAt: new Date(daysAgo(20).getTime() + 3600e3) },
        { tenantId: "buyer-1", status: "completed", createdAt: daysAgo(10), paidAt: new Date(daysAgo(10).getTime() + 2 * 3600e3) },
      ],
    });
    const res = await suggestLimitTx(db, "buyer-1", "supplier-1", NOW);
    expect(res.score).toBe(100);
    expect(res.suggestedLimitCents).toBe(VOLUME_TARGET_CENTS);
    expect(res.reasons[0]).toBe("on-time rate 100%");
    expect(res.reasons[1]).toBe("₦5M 30-day volume");
    expect(res.reasons[2]).toBe("12 months tenure");
  });

  it("late payments lower the score vs on-time history (0.5 weight on on-time)", async () => {
    const mk = (onTime: boolean) => makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3) }],
      payments: [{
        tenantId: "b", status: "completed", createdAt: daysAgo(10),
        paidAt: new Date(daysAgo(10).getTime() + (onTime ? 3600e3 : 72 * 3600e3)),
      }],
    });
    const good = await suggestLimitTx(mk(true).db, "b", "s", NOW);
    const bad = await suggestLimitTx(mk(false).db, "b", "s", NOW);
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.reasons[0]).toBe("on-time rate 0%");
    expect(good.suggestedLimitCents).toBeGreaterThan(bad.suggestedLimitCents);
  });

  it("no completed payments → neutral prior, noted in reasons", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3) }],
      payments: [{ tenantId: "b", status: "failed", createdAt: daysAgo(10), paidAt: null }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.reasons[0]).toContain("neutral");
    expect(res.score).toBeGreaterThan(0);
  });

  it("orders older than 30d count for tenure but not for 30-day volume", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "9000000.00", createdAt: daysAgo(420) }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.reasons[1]).toBe("₦0 30-day volume");
    expect(res.reasons[2]).toBe("14 months tenure");
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS); // volume 0 → floor
  });

  it("suggested limit is clamped at the cap for very large volume", async () => {
    const { db } = makeFakeDb({
      orders: [
        { tenantId: "b", totalAmount: "99999999.00", createdAt: daysAgo(2) },
        { tenantId: "b", totalAmount: "1.00", createdAt: daysAgo(800) },
      ],
      payments: [{ tenantId: "b", status: "completed", createdAt: daysAgo(5), paidAt: daysAgo(4) }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.suggestedLimitCents).toBeLessThanOrEqual(CAP_LIMIT_CENTS);
  });

  it("ignores other tenants' history (buyer scoping)", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "someone-else", totalAmount: "5000000.00", createdAt: daysAgo(2) }],
      payments: [{ tenantId: "someone-else", status: "completed", createdAt: daysAgo(2), paidAt: daysAgo(1) }],
    });
    const res = await suggestLimitTx(db, "buyer-1", "supplier-1", NOW);
    expect(res.score).toBe(COLD_START_SCORE);
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS);
  });

  it("supplierTenantId does not change platform-wide scoring (documented)", async () => {
    const seed = {
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(2) }],
    };
    const a = await suggestLimitTx(makeFakeDb(seed).db, "b", "supplier-A", NOW);
    const b = await suggestLimitTx(makeFakeDb(seed).db, "b", "supplier-B", NOW);
    expect(a).toEqual(b);
  });
});

/**
 * W18 credit-outcome-aware scoring: with platform credit history present the
 * credit factor is the dominant signal (weight 0.5, SCORING_WEIGHTS
 * .withCreditHistory); without it the legacy weights apply unchanged.
 *
 * Shared fixture: ₦1,000,000 30-day volume (volumeFactor 0.2), 0 months
 * tenure, one on-time payment (on-time rate 100%). Legacy score for this
 * fixture: 56. Credit-history scores below are exact (deterministic formula):
 *   score = round(100 * (0.5*creditFactor + 0.25*1 + 0.15*0.2 + 0.1*0))
 *         = round(100 * (0.5*creditFactor + 0.28))
 */
describe("suggestLimitTx — W18 credit history (dominant signal)", () => {
  const baseSeed = {
    orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3) }],
    payments: [
      { tenantId: "b", status: "completed", createdAt: daysAgo(10), paidAt: new Date(daysAgo(10).getTime() + 3600e3) },
    ],
  };
  const mk = (accounts: any[], ledger: any[]) =>
    makeFakeDb({ ...baseSeed, accounts, ledger }).db;

  it("weights: credit history dominates when present, legacy otherwise", () => {
    expect(SCORING_WEIGHTS.noCreditHistory).toEqual({ onTime: 0.5, volume: 0.3, tenure: 0.2 });
    expect(SCORING_WEIGHTS.withCreditHistory).toEqual({ credit: 0.5, onTime: 0.25, volume: 0.15, tenure: 0.1 });
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(SCORING_WEIGHTS.noCreditHistory)).toBeCloseTo(1);
    expect(sum(SCORING_WEIGHTS.withCreditHistory)).toBeCloseTo(1);
  });

  it("facility repaid on time raises the score (+0.10 credit) with a reason", async () => {
    const db = mk(
      [seedAccount({ id: "acct-1", buyerTenantId: "b", outstandingCents: 0 })],
      [seedDraw("acct-1", { amountCents: 5_000_000, status: "settled", dueDate: daysAgo(10) })],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.score).toBe(58); // creditFactor 0.6 → 0.30 + 0.28
    expect(res.score).toBeGreaterThan(56); // legacy no-history score
    expect(res.reasons).toContain("credit: 1 facility repaid on time");
    expect(res.suggestedLimitCents).toBe(66_400_000);
  });

  it("three on-time facilities cap the bonus (+0.30 credit) — plural reason", async () => {
    const db = mk(
      [
        seedAccount({ id: "a1", buyerTenantId: "b", outstandingCents: 0 }),
        seedAccount({ id: "a2", buyerTenantId: "b", outstandingCents: 0 }),
        seedAccount({ id: "a3", buyerTenantId: "b", outstandingCents: 0 }),
      ],
      [
        seedDraw("a1", { status: "settled" }),
        seedDraw("a2", { status: "settled" }),
        seedDraw("a3", { status: "settled" }),
      ],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.score).toBe(68); // creditFactor 0.8 → 0.40 + 0.28
    expect(res.reasons).toContain("credit: 3 facilities repaid on time");
  });

  it("a late repayment (dunning fee marker) lowers the score below neutral", async () => {
    const db = mk(
      [seedAccount({ id: "acct-1", buyerTenantId: "b", outstandingCents: 0 })],
      [seedDraw("acct-1", { status: "settled", dueDate: daysAgo(30), note: "Late fee [dun:fee]" })],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    // late (−0.15) + cured-at-zero (+0.10) → creditFactor 0.45 → 51
    expect(res.score).toBe(51);
    expect(res.score).toBeLessThan(56);
    expect(res.reasons).toContain("credit: 1 late repayment");
    expect(res.reasons).toContain("credit: recovered to zero after late repayment");
    expect(res.reasons).not.toContain("credit: active default / frozen account");
  });

  it("active default (frozen account) is the heaviest penalty", async () => {
    const db = mk(
      [seedAccount({ id: "acct-1", buyerTenantId: "b", status: "frozen", outstandingCents: 5_000_000 })],
      [seedDraw("acct-1", { status: "posted", dueDate: daysAgo(30), note: "[dun:fee] [dun:r+7]" })],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    // 0.5 − 0.15 (late) − 0.40 (default) = 0 (clamped) → score 28
    expect(res.score).toBe(28);
    expect(res.reasons).toContain("credit: active default / frozen account");
    expect(res.reasons).not.toContain("credit: recovered to zero after late repayment");
    expect(res.terms).toEqual({ tenorDays: 14, feeBps: 350, decline: false });
  });

  it("posted draw overdue past the freeze horizon counts as active default", async () => {
    const db = mk(
      [seedAccount({ id: "acct-1", buyerTenantId: "b", limitCents: 10_000_000, outstandingCents: 5_000_000 })],
      [seedDraw("acct-1", { status: "posted", dueDate: daysAgo(20) })],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    // 0.5 − 0.40 (default) + 0.05 (utilization 50% healthy) = 0.15 → 36
    expect(res.score).toBe(36);
    expect(res.reasons).toContain("credit: active default / frozen account");
  });

  it("healthy utilization band (0 < outstanding/limit ≤ 70%) adds a small bonus", async () => {
    const db = mk(
      [seedAccount({ id: "acct-1", buyerTenantId: "b", limitCents: 10_000_000, outstandingCents: 5_000_000 })],
      [seedDraw("acct-1", { status: "posted", dueDate: new Date(NOW.getTime() + 5 * 864e5) })],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.score).toBe(56); // creditFactor 0.55 → 0.275 + 0.28
    expect(res.reasons).toContain("credit: utilization in healthy band");
  });

  it("credit history is platform-wide: another supplier's facility counts", async () => {
    const db = mk(
      [seedAccount({ id: "acct-9", supplierTenantId: "other-supplier", buyerTenantId: "b", outstandingCents: 0 })],
      [seedDraw("acct-9", { status: "settled" })],
    );
    const res = await suggestLimitTx(db, "b", "supplier-asking", NOW);
    expect(res.score).toBe(58);
    expect(res.reasons).toContain("credit: 1 facility repaid on time");
  });

  it("a credit account with NO ledger rows is not credit history (legacy weights)", async () => {
    const db = mk([seedAccount({ id: "acct-1", buyerTenantId: "b" })], []);
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.score).toBe(56); // identical to the pre-W18 formula
    expect(res.reasons.filter((r) => r.startsWith("credit:"))).toHaveLength(0);
  });

  it("void draws do not count as credit history", async () => {
    const db = mk(
      [seedAccount({ id: "acct-1", buyerTenantId: "b" })],
      [seedDraw("acct-1", { status: "void" })],
    );
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.score).toBe(56);
  });

  it("credit history alone (no orders/payments) escapes cold start", async () => {
    const db = makeFakeDb({
      accounts: [seedAccount({ id: "acct-1", buyerTenantId: "b", outstandingCents: 0 })],
      ledger: [seedDraw("acct-1", { status: "settled" })],
    }).db;
    const res = await suggestLimitTx(db, "b", "s", NOW);
    // not cold start: creditFactor 0.6, onTime prior 0.5, volume 0, tenure 0
    // score = round(100 * (0.5*0.6 + 0.25*0.5)) = 43 (42.5 → 43)
    expect(res.score).toBe(43);
    expect(res.reasons[0]).not.toContain("cold-start");
    expect(res.suggestedLimitCents).toBe(FLOOR_LIMIT_CENTS); // zero volume
  });

  it("score < 20 adds a decline reason and decline terms", async () => {
    const db = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "10000.00", createdAt: daysAgo(2) }],
      accounts: [seedAccount({ id: "acct-1", buyerTenantId: "b", status: "frozen", outstandingCents: 1_000_000 })],
      ledger: [
        seedDraw("acct-1", { status: "posted", dueDate: daysAgo(60), note: "[dun:fee] [dun:r+7]" }),
        seedDraw("acct-1", { status: "posted", dueDate: daysAgo(50), note: "[dun:fee] [dun:r+7]" }),
        seedDraw("acct-1", { status: "posted", dueDate: daysAgo(40), note: "[dun:fee] [dun:r+7]" }),
      ],
    }).db;
    const res = await suggestLimitTx(db, "b", "s", NOW);
    // creditFactor 0 (0.5 − 3×0.15 − 0.4 clamped); on-time prior 0.5
    // score = round(100 * (0.25*0.5 + 0.15*0.0002)) ≈ 13
    expect(res.score).toBeLessThan(20);
    expect(res.terms.decline).toBe(true);
    expect(res.reasons.some((r) => r.includes("decline credit suggestion"))).toBe(true);
  });

  it("result always carries terms and antiGamingFlags", async () => {
    const res = await suggestLimitTx(makeFakeDb(baseSeed).db, "b", "s", NOW);
    expect(res.terms).toEqual({ tenorDays: 21, feeBps: 250, decline: false }); // score 56
    expect(res.antiGamingFlags).toEqual([]);
  });
});

describe("creditFactorFromSignals — pure signal math", () => {
  const base = {
    hasHistory: true,
    onTimeFacilities: 0,
    lateRepayments: 0,
    activeDefault: false,
    curedAtZero: false,
    healthyUtilization: false,
  };
  it("neutral base 0.5, clamped to 0..1", () => {
    expect(creditFactorFromSignals(base)).toBe(0.5);
    expect(creditFactorFromSignals({ ...base, onTimeFacilities: 99, curedAtZero: true, healthyUtilization: true })).toBeCloseTo(0.95);
    expect(creditFactorFromSignals({ ...base, lateRepayments: 99, activeDefault: true })).toBe(0);
  });
  it("cure bonus does not stack with an active default", () => {
    expect(creditFactorFromSignals({ ...base, lateRepayments: 1, curedAtZero: true })).toBeCloseTo(0.45);
    expect(creditFactorFromSignals({ ...base, lateRepayments: 1, curedAtZero: true, activeDefault: true })).toBeCloseTo(0);
  });
});

describe("suggestLimitTx — W18 anti-gaming wiring", () => {
  it("self-dealing volume is excluded from the suggestion and flagged in reasons", async () => {
    const { db } = makeFakeDb({
      orders: [
        { tenantId: "b", totalAmount: "4000000.00", createdAt: daysAgo(2), customerId: "c-owner" },
        { tenantId: "b", totalAmount: "500000.00", createdAt: daysAgo(3), customerId: "c-real" },
        { tenantId: "b", totalAmount: "300000.00", createdAt: daysAgo(4), customerId: "c-real2" },
      ],
      customers: [
        { id: "c-owner", tenantId: "b", whatsappPhone: "+234800" },
        { id: "c-real", tenantId: "b", whatsappPhone: "+234801" },
        { id: "c-real2", tenantId: "b", whatsappPhone: "+234802" },
      ],
      users: [{ tenantId: "b", phone: "+234800" }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.antiGamingFlags).toEqual(["self_dealing_volume"]);
    expect(res.reasons.some((r) => r === "anti-gaming flag: self_dealing_volume")).toBe(true);
    // Adjusted volume ₦800k of the raw ₦4.8M.
    expect(res.reasons[1]).toBe("₦800k 30-day volume (adjusted from ₦4.8M)");
    // volumeFactor uses the ADJUSTED volume: 0.16 → with on-time prior 0.5,
    // tenure 0 → score = round(100*(0.5*0.5 + 0.3*0.16*(1-0.2))) = 29
    expect(res.score).toBe(29);
  });

  it("clean history → no flags, no adjustment (unchanged behavior)", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3), customerId: "c1" }],
      customers: [{ id: "c1", tenantId: "b", whatsappPhone: "+234801" }],
      users: [{ tenantId: "b", phone: "+234899" }],
    });
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.antiGamingFlags).toEqual([]);
    expect(res.reasons[1]).toBe("₦1M 30-day volume");
  });

  it("fail-open: anti-gaming db failure → unadjusted volume + anti_gaming_unavailable flag", async () => {
    const { db } = makeFakeDb({
      orders: [{ tenantId: "b", totalAmount: "1000000.00", createdAt: daysAgo(3), customerId: "c1" }],
    });
    const orig = db.select;
    let calls = 0;
    (db as any).select = (...a: any[]) => {
      calls += 1;
      if (calls > 4) throw new Error("boom"); // anti-gaming enrichment queries fail
      return orig.apply(db, a as any);
    };
    const res = await suggestLimitTx(db, "b", "s", NOW);
    expect(res.antiGamingFlags).toEqual(["anti_gaming_unavailable"]);
    expect(res.reasons.some((r) => r === "anti-gaming flag: anti_gaming_unavailable")).toBe(true);
    expect(res.reasons[1]).toBe("₦1M 30-day volume"); // unadjusted
  });
});
