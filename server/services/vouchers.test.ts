import { describe, expect, it } from "vitest";
import { areCategoriesEligible, isPhoneEligible, issuerReportCsv, voucherCode, VoucherError } from "./vouchers";

describe("voucher codes (deterministic)", () => {
  it("same inputs → same code; different seq → different code", () => {
    const a = voucherCode("prog-1", "2348000000001", 0);
    expect(voucherCode("prog-1", "2348000000001", 0)).toBe(a);
    expect(voucherCode("prog-1", "2348000000001", 1)).not.toBe(a);
    expect(voucherCode("prog-1", "2348000000002", 0)).not.toBe(a);
    expect(a).toMatch(/^[A-Z0-9]{16}$/);
  });
});

describe("eligibility rules", () => {
  it("phone eligibility: null = all, list = membership", () => {
    expect(isPhoneEligible(null, "2341")).toBe(true);
    expect(isPhoneEligible(["2341", "2342"], "2341")).toBe(true);
    expect(isPhoneEligible(["2341"], "2349")).toBe(false);
    expect(isPhoneEligible([], "2341")).toBe(false);
  });
  it("category restriction: null/empty = all; otherwise subset check", () => {
    expect(areCategoriesEligible(null, ["food"])).toBe(true);
    expect(areCategoriesEligible([], ["food"])).toBe(true);
    expect(areCategoriesEligible(["food", "agri"], ["food"])).toBe(true);
    expect(areCategoriesEligible(["food"], ["food", "electronics"])).toBe(false);
    expect(areCategoriesEligible(["Food"], ["FOOD"])).toBe(true); // case-insensitive
  });
});

describe("issuerReportCsv", () => {
  it("emits deterministic summary + rows, escaping commas", () => {
    const csv = issuerReportCsv({
      programId: "p1", issuer: "Lagos State, Ministry of Agriculture", name: "Inputs 2026",
      currency: "NGN", budgetCents: 1_000_000, issuedCents: 200_000, redeemedCents: 100_000,
      outstandingCents: 100_000, remainingBudgetCents: 800_000, voucherCount: 2, redeemedCount: 1,
      rows: [
        { code: "AAA", recipientPhone: "2341", amountCents: 100_000, currency: "NGN", status: "redeemed", orderId: "o1", issuedAt: "2026-01-01T00:00:00.000Z", redeemedAt: "2026-01-02T00:00:00.000Z" },
        { code: "BBB", recipientPhone: "2342", amountCents: 100_000, currency: "NGN", status: "issued", orderId: null, issuedAt: "2026-01-01T00:00:00.000Z", redeemedAt: null },
      ],
    });
    const lines = csv.split("\n");
    expect(lines[0]).toContain('"Lagos State, Ministry of Agriculture"');
    expect(lines[0]).toContain("budget_cents=1000000");
    expect(lines[1]).toBe("code,recipient_phone,amount_cents,currency,status,order_id,issued_at,redeemed_at");
    expect(lines[2]).toBe("AAA,2341,100000,NGN,redeemed,o1,2026-01-01T00:00:00.000Z,2026-01-02T00:00:00.000Z");
    expect(lines[3]).toBe("BBB,2342,100000,NGN,issued,,2026-01-01T00:00:00.000Z,");
  });
});

describe("VoucherError", () => {
  it("carries a stable machine code", () => {
    expect(new VoucherError("REDEEMED", "x").code).toBe("REDEEMED");
  });
});
