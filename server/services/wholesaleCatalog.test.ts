/**
 * W27 wholesaleCatalog — pure pricing/formatting unit tests (hermetic).
 * DB paths are covered end-to-end by journeys J146–J147 on real PGlite.
 */
import { describe, it, expect } from "vitest";
import { computeTieredPrice, formatMajor, formatListingForWhatsApp } from "./wholesaleCatalog";

const tiers = [
  { minQty: 1, maxQty: 49, unitPriceCents: 500_00 },   // ₦500.00
  { minQty: 50, maxQty: 199, unitPriceCents: 450_00 }, // ₦450.00
  { minQty: 200, maxQty: null, unitPriceCents: 400_00 },
];

describe("computeTieredPrice", () => {
  it("resolves the correct band and exact integer-cents totals", () => {
    expect(computeTieredPrice(tiers, 1, 1)).toMatchObject({ ok: true, unitPriceCents: 50000, totalCents: 50000 });
    expect(computeTieredPrice(tiers, 50, 1)).toMatchObject({ ok: true, unitPriceCents: 45000, totalCents: 2_250_000 });
    expect(computeTieredPrice(tiers, 10_000, 1)).toMatchObject({ ok: true, unitPriceCents: 40000, totalCents: 400_000_000 });
  });

  it("boundary quantities land in the right band", () => {
    expect(computeTieredPrice(tiers, 49, 1)).toMatchObject({ ok: true, unitPriceCents: 50000 });
    expect(computeTieredPrice(tiers, 199, 1)).toMatchObject({ ok: true, unitPriceCents: 45000 });
    expect(computeTieredPrice(tiers, 200, 1)).toMatchObject({ ok: true, unitPriceCents: 40000 });
  });

  it("enforces MOQ", () => {
    expect(computeTieredPrice(tiers, 9, 10)).toEqual({ ok: false, reason: "below_moq" });
    expect(computeTieredPrice(tiers, 10, 10)).toMatchObject({ ok: true });
  });

  it("rejects invalid quantities and empty tier lists", () => {
    expect(computeTieredPrice(tiers, 0, 1)).toEqual({ ok: false, reason: "invalid_qty" });
    expect(computeTieredPrice(tiers, -5, 1)).toEqual({ ok: false, reason: "invalid_qty" });
    expect(computeTieredPrice(tiers, 1.5, 1)).toEqual({ ok: false, reason: "invalid_qty" });
    expect(computeTieredPrice([], 10, 1)).toEqual({ ok: false, reason: "no_tier" });
  });

  it("overlapping bands resolve deterministically (highest minQty wins)", () => {
    const overlap = [
      { minQty: 1, maxQty: null, unitPriceCents: 100 },
      { minQty: 10, maxQty: null, unitPriceCents: 200 },
    ];
    expect(computeTieredPrice(overlap, 15, 1)).toMatchObject({ ok: true, unitPriceCents: 200 });
    expect(computeTieredPrice(overlap, 5, 1)).toMatchObject({ ok: true, unitPriceCents: 100 });
  });
});

describe("formatMajor", () => {
  it("formats integer cents as major units", () => {
    expect(formatMajor(123_456_789)).toBe("NGN 1,234,567.89");
    expect(formatMajor(0)).toBe("NGN 0.00");
    expect(formatMajor(5, "KES")).toBe("KES 0.05");
  });
});

describe("formatListingForWhatsApp", () => {
  it("includes MOQ, tier summary and a short id", () => {
    const s = formatListingForWhatsApp(
      { id: "abcd1234-0000-0000-0000-000000000000", title: "Rice 50kg", moq: 10, currency: "NGN" } as any,
      [{ minQty: 10, maxQty: 99, unitPriceCents: 2_500_000 } as any],
      0,
    );
    expect(s).toContain("Rice 50kg");
    expect(s).toContain("MOQ 10");
    expect(s).toContain("NGN 25,000.00/unit");
    expect(s).toContain("abcd1234");
    expect(s.startsWith("1. ")).toBe(true);
  });
});
