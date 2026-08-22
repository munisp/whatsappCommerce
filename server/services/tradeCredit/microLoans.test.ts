/**
 * W27 credit — unit tests for the pure micro-loan primitives (offer sizing
 * tiers, per-sale deduction, schedule derivation). DB flows (accept /
 * disburse / sweep idempotency) are covered end-to-end by journeys
 * J139–J141 against PGlite.
 */
import { describe, it, expect } from "vitest";
import {
  tierForScore,
  sizeOffer,
  deductionForSale,
  loanRepaymentRef,
  repaymentScheduleFor,
  LOAN_TIERS,
  MIN_LOAN_CENTS,
  MAX_LOAN_CENTS,
} from "./microLoans";
import type { MerchantLoan } from "../../../drizzle/schema";

describe("tierForScore", () => {
  it("maps score bands to tiers", () => {
    expect(tierForScore(1000)?.tier).toBe("A");
    expect(tierForScore(800)?.tier).toBe("A");
    expect(tierForScore(799)?.tier).toBe("B");
    expect(tierForScore(600)?.tier).toBe("B");
    expect(tierForScore(599)?.tier).toBe("C");
    expect(tierForScore(400)?.tier).toBe("C");
    expect(tierForScore(399)).toBeNull();
    expect(tierForScore(0)).toBeNull();
  });
});

describe("sizeOffer", () => {
  const tierA = LOAN_TIERS[0];

  it("caps principal at the tier volume percentage", () => {
    const offer = sizeOffer(tierA, 10_000_000)!; // 50% → 5_000_000
    expect(offer.maxPrincipalCents).toBe(5_000_000);
    expect(offer.feeCents).toBe(250_000); // 5%
    expect(offer.totalRepayCents).toBe(5_250_000);
    expect(offer.repaymentPct).toBe(20);
  });

  it("clamps principal to MAX_LOAN_CENTS", () => {
    const offer = sizeOffer(tierA, 1_000_000_000)!;
    expect(offer.maxPrincipalCents).toBe(MAX_LOAN_CENTS);
  });

  it("returns null below MIN_LOAN_CENTS (insufficient volume)", () => {
    const tiny = sizeOffer(LOAN_TIERS[2], 100_000); // 15% of ₦1,000 = ₦150
    expect(tiny).toBeNull();
    expect(MIN_LOAN_CENTS).toBeGreaterThan(15_000);
  });

  it("is deterministic and integer-only", () => {
    const a = sizeOffer(tierA, 7_777_777)!;
    const b = sizeOffer(tierA, 7_777_777)!;
    expect(a).toEqual(b);
    expect(Number.isInteger(a.maxPrincipalCents)).toBe(true);
    expect(Number.isInteger(a.feeCents)).toBe(true);
  });
});

describe("deductionForSale", () => {
  it("takes the floor of pct of the sale", () => {
    expect(deductionForSale(10_001, 20, 999_999)).toBe(2_000);
  });
  it("never exceeds the outstanding balance", () => {
    expect(deductionForSale(1_000_000, 25, 100)).toBe(100);
  });
  it("is zero for zero sale or zero outstanding", () => {
    expect(deductionForSale(0, 20, 1000)).toBe(0);
    expect(deductionForSale(1000, 20, 0)).toBe(0);
  });
});

describe("loanRepaymentRef", () => {
  it("is deterministic and fits the reference column", () => {
    const ref = loanRepaymentRef("loan-1", "wtx-9");
    expect(ref).toBe("loanrepay:loan-1:wtx-9");
    expect(loanRepaymentRef("x".repeat(100), "y".repeat(100)).length).toBeLessThanOrEqual(160);
  });
});

describe("repaymentScheduleFor", () => {
  it("derives the pct-of-sale rule plus the due-date entry", () => {
    const loan = {
      id: "l1", tenantId: "t", merchantId: "m", status: "active",
      principalCents: 1_000_000, feeCents: 50_000, outstandingCents: 700_000,
      repaymentPct: 20, scoreAtAccept: 700, tier: "B", currency: "NGN",
      walletTxId: null, disbursedAt: new Date("2026-01-01"),
      dueAt: new Date("2026-01-31"), repaidAt: null, defaultedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    } as unknown as MerchantLoan;
    const sched = repaymentScheduleFor(loan);
    expect(sched).toHaveLength(2);
    expect(sched[0].kind).toBe("per_sale");
    expect(sched[0].label).toContain("20%");
    expect(sched[1].amountCents).toBe(700_000);
    expect(sched[1].at).toEqual(new Date("2026-01-31"));
  });
});
