/**
 * W27 bookkeeping — pure-function unit tests: money conversion/formatting,
 * UTC period math, digest rendering (incl. week-over-week), category
 * normalization, expense-date parsing, CSV/PDF export shapes.
 * DB-touching paths are exercised end-to-end by journeys J131–J134.
 */
import { describe, expect, it } from "vitest";
import {
  exportToCsv,
  exportToPdf,
  formatNaira,
  formatNairaExact,
  normalizeCategory,
  parseExpenseDate,
  periodRange,
  renderDigestMessage,
  toCents,
  type BookkeepingExport,
  type SalesSummary,
} from "./bookkeeping";

describe("toCents", () => {
  it("converts decimal major units to integer cents", () => {
    expect(toCents("2500.00")).toBe(250000);
    expect(toCents("42300")).toBe(4230000);
    expect(toCents(0.1)).toBe(10);
    expect(toCents("0.29")).toBe(29);
  });
  it("rounds half-up deterministically, no float drift", () => {
    expect(toCents("2.675")).toBe(268); // classic float trap
    expect(toCents(19.99)).toBe(1999);
  });
  it("handles null/garbage", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("abc")).toBe(0);
  });
});

describe("formatNaira / formatNairaExact", () => {
  it("groups thousands and renders ₦", () => {
    expect(formatNaira(4230000)).toBe("₦42,300");
    expect(formatNaira(500)).toBe("₦5");
  });
  it("exact keeps kobo only when non-zero", () => {
    expect(formatNairaExact(4230050)).toBe("₦42,300.50");
    expect(formatNairaExact(4230000)).toBe("₦42,300");
  });
  it("negative amounts carry a sign", () => {
    expect(formatNairaExact(-150000)).toBe("-₦1,500");
  });
});

describe("periodRange (UTC)", () => {
  const now = new Date("2026-02-14T15:30:00.000Z"); // Saturday
  it("daily = the UTC day containing now; prev = yesterday", () => {
    const p = periodRange("daily", now);
    expect(p.from.toISOString()).toBe("2026-02-14T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(p.prevFrom.toISOString()).toBe("2026-02-13T00:00:00.000Z");
    expect(p.prevTo.toISOString()).toBe("2026-02-14T00:00:00.000Z");
    expect(p.periodKey).toBe("D2026-02-14");
  });
  it("weekly = last 7 UTC days inclusive; prev = the 7 before", () => {
    const p = periodRange("weekly", now);
    expect(p.from.toISOString()).toBe("2026-02-08T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(p.prevFrom.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(p.prevTo.toISOString()).toBe("2026-02-08T00:00:00.000Z");
    expect(p.periodKey).toBe("W2026-02-14");
  });
  it("host-timezone independent (pinned instants only)", () => {
    const edge = new Date("2026-02-14T00:00:00.000Z");
    expect(periodRange("daily", edge).periodKey).toBe("D2026-02-14");
  });
});

function summary(over: Partial<SalesSummary>): SalesSummary {
  return {
    tenantId: "t1", frequency: "weekly", periodKey: "W2026-02-14",
    from: new Date("2026-02-08T00:00:00Z"), to: new Date("2026-02-15T00:00:00Z"),
    salesCents: 0, orderCount: 0, prevSalesCents: 0, prevOrderCount: 0,
    changePct: null, currency: "NGN", ...over,
  };
}

describe("renderDigestMessage", () => {
  it("renders the spec example: up 12%", () => {
    const msg = renderDigestMessage(summary({ salesCents: 4230000, orderCount: 5, prevSalesCents: 3777000, changePct: 12 }));
    expect(msg).toContain("You made ₦42,300 this week");
    expect(msg).toContain("up 12% vs last week");
    expect(msg).toContain("5 orders");
  });
  it("down / flat / no-baseline variants", () => {
    expect(renderDigestMessage(summary({ salesCents: 100000, orderCount: 1, prevSalesCents: 200000, changePct: -50 })))
      .toContain("down 50% vs last week");
    expect(renderDigestMessage(summary({ salesCents: 100000, orderCount: 2, prevSalesCents: 100000, changePct: 0 })))
      .toContain("flat vs last week");
    expect(renderDigestMessage(summary({ salesCents: 100000, orderCount: 2 })))
      .toContain("no sales last week to compare");
  });
  it("daily span wording", () => {
    const msg = renderDigestMessage(summary({ frequency: "daily", salesCents: 250000, orderCount: 1, prevSalesCents: 125000, changePct: 100 }));
    expect(msg).toContain("You made ₦2,500 today, up 100% vs yesterday (1 order)");
  });
});

describe("week-over-week math (changePct)", () => {
  // Mirrors computeSalesSummary's formula against the pure inputs.
  const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
  it("up 12%", () => expect(pct(4230000, 3777000)).toBe(12));
  it("null when previous period was zero", () => expect(pct(100, 0)).toBeNull());
  it("negative and zero cases", () => {
    expect(pct(50, 200)).toBe(-75);
    expect(pct(200, 200)).toBe(0);
  });
});

describe("normalizeCategory", () => {
  it("accepts known categories case-insensitively", () => {
    expect(normalizeCategory("Stock")).toBe("stock");
    expect(normalizeCategory(" transport ")).toBe("transport");
  });
  it("falls back to general", () => {
    expect(normalizeCategory("yacht")).toBe("general");
    expect(normalizeCategory(null)).toBe("general");
  });
});

describe("parseExpenseDate", () => {
  const fallback = new Date("2026-02-14T00:00:00Z");
  it("parses ISO and DD/MM/YYYY", () => {
    expect(parseExpenseDate("2026-01-05", fallback).toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(parseExpenseDate("receipt 05/01/2026 total", fallback).toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });
  it("falls back on garbage", () => {
    expect(parseExpenseDate("no date here", fallback)).toBe(fallback);
    expect(parseExpenseDate(null, fallback)).toBe(fallback);
  });
});

function sampleExport(): BookkeepingExport {
  return {
    tenantId: "sim-tenant",
    from: new Date("2026-02-01T00:00:00Z"),
    to: new Date("2026-03-01T00:00:00Z"),
    currency: "NGN",
    sales: [
      { orderNumber: "ORD-1", date: "2026-02-03", amountCents: 250000, currency: "NGN" },
      { orderNumber: 'ORD-"2"', date: "2026-02-04", amountCents: 3980000, currency: "NGN" },
    ],
    expenseRows: [
      { date: "2026-02-05", vendor: "Chidi, Supplies", category: "stock", amountCents: 150000 },
    ],
    totalSalesCents: 4230000,
    totalExpensesCents: 150000,
    netCents: 4080000,
  };
}

describe("exportToCsv", () => {
  it("contains a formalization-friendly summary block + both sections", () => {
    const csv = exportToCsv(sampleExport());
    expect(csv).toContain("Total sales,42300.00");
    expect(csv).toContain("Total expenses,1500.00");
    expect(csv).toContain("Net income,40800.00");
    expect(csv).toContain("order_number,date,amount");
    expect(csv).toContain("ORD-1,2026-02-03,2500.00");
    expect(csv).toContain("date,vendor,category,amount");
    // CSV escaping: comma and quotes in values
    expect(csv).toContain('"Chidi, Supplies"');
    expect(csv).toContain('"ORD-""2"""');
  });
  it("net = sales - expenses (integer cents)", () => {
    const x = sampleExport();
    expect(x.netCents).toBe(x.totalSalesCents - x.totalExpensesCents);
  });
});

describe("exportToPdf", () => {
  it("produces a structurally valid minimal PDF", () => {
    const pdf = exportToPdf(sampleExport());
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("%%EOF");
    expect(text).toContain("Total sales:");
    expect(text).toContain("Net income:");
    expect(text).toContain("xref");
    expect(pdf.length).toBeGreaterThan(400);
  });
  it("escapes parentheses in content", () => {
    const x = sampleExport();
    x.expenseRows[0].vendor = "Shop (Lagos)";
    const text = exportToPdf(x).toString("latin1");
    expect(text).toContain("Shop \\(Lagos\\)");
  });
});
