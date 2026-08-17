/**
 * W15 normalization tests — name cleanup, ₦/$ price parsing (commas,
 * ranges, per-unit), confidence scoring, dedupe keys. Pure functions.
 */
import { describe, it, expect } from "vitest";
import {
  cleanName,
  normalizeNameKey,
  parsePriceText,
  scoreConfidence,
} from "../parse";

describe("cleanName", () => {
  it("strips OCR bullets and collapses whitespace", () => {
    expect(cleanName("•  Indomie   Chicken 70g")).toBe("Indomie Chicken 70g");
  });

  it("title-cases fully-uppercase OCR output", () => {
    expect(cleanName("RICE 50KG BAG")).toBe("Rice 50kg Bag");
  });

  it("strips trailing punctuation", () => {
    expect(cleanName("Peak Milk,")).toBe("Peak Milk");
  });

  it("rejects empty / numeric-only / too-short names", () => {
    expect(cleanName("")).toBe("");
    expect(cleanName("1234")).toBe("");
    expect(cleanName("a")).toBe("");
    expect(cleanName(42)).toBe("");
  });
});

describe("normalizeNameKey", () => {
  it("is case/space/punctuation-insensitive", () => {
    expect(normalizeNameKey("Coca-Cola  50cl")).toBe(normalizeNameKey("coca cola 50cl"));
  });
});

describe("parsePriceText", () => {
  it("parses ₦ with thousands commas", () => {
    expect(parsePriceText("₦1,500")).toEqual({ priceCents: 150000, currency: "NGN", unit: undefined });
  });

  it("parses N-prefix and bare numbers with NGN default", () => {
    expect(parsePriceText("N250")?.priceCents).toBe(25000);
    expect(parsePriceText("1500.00")?.priceCents).toBe(150000);
    expect(parsePriceText("1500.00")?.currency).toBe("NGN");
  });

  it("detects $/USD", () => {
    expect(parsePriceText("$2.50")).toEqual({ priceCents: 250, currency: "USD", unit: undefined });
  });

  it("ranges take the lower bound and are flagged", () => {
    const r = parsePriceText("₦500-700");
    expect(r?.priceCents).toBe(50000);
    expect(r?.fromRange).toBe(true);
  });

  it("captures per-dozen / per-pack units", () => {
    const r = parsePriceText("₦6,000/dozen");
    expect(r?.priceCents).toBe(600000);
    expect(r?.unit).toBe("dozen");
    expect(parsePriceText("₦1,200 per pack")?.unit).toBe("pack");
  });

  it("rejects implausible or missing prices", () => {
    expect(parsePriceText("free")).toBeNull();
    expect(parsePriceText("₦0")).toBeNull();
    expect(parsePriceText("₦0.10")).toBeNull(); // below 50 cents
    expect(parsePriceText(undefined)).toBeNull();
  });

  it("accepts trusted numeric major units", () => {
    expect(parsePriceText(1500)).toEqual({ priceCents: 150000, currency: "NGN" });
    expect(parsePriceText(-5)).toBeNull();
  });
});

describe("scoreConfidence", () => {
  it("scores a clean priced item high", () => {
    const c = scoreConfidence({ name: "Indomie Chicken 70g", priceCents: 25000, currency: "NGN" });
    expect(c).toBeGreaterThanOrEqual(0.8);
    expect(c).toBeLessThanOrEqual(1);
  });

  it("penalizes range-derived prices", () => {
    const clean = scoreConfidence({ name: "Rice", priceCents: 50000, currency: "NGN" });
    const ranged = scoreConfidence({ name: "Rice", priceCents: 50000, currency: "NGN", fromRange: true });
    expect(ranged).toBeLessThan(clean);
  });

  it("upstream confidence adds a small bonus and stays clamped to [0,1]", () => {
    const withUp = scoreConfidence({
      name: "Rice", priceCents: 50000, currency: "NGN", sku: "R-1", upstreamConfidence: 1,
    });
    expect(withUp).toBeLessThanOrEqual(1);
    expect(withUp).toBeGreaterThan(
      scoreConfidence({ name: "Rice", priceCents: 50000, currency: "NGN", sku: "R-1" }),
    );
  });
});
