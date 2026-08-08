/**
 * Unit tests for the pure helpers backing the WhatsApp ops frontend
 * (client/src/lib/waOps.ts): template {{n}} param extraction/preview,
 * template + quality badge mapping, and notification-delivery glyphs.
 */
import { describe, expect, it } from "vitest";
import {
  extractTemplateParams,
  notifStatusGlyph,
  previewTemplateBody,
  receiptTimestamp,
  waQualityBadge,
  waTemplateStatusBadge,
} from "../client/src/lib/waOps";

describe("extractTemplateParams", () => {
  it("extracts sorted unique param numbers", () => {
    expect(extractTemplateParams("Hi {{2}}, order {{1}} — again {{2}}")).toEqual([1, 2]);
  });

  it("handles whitespace inside braces", () => {
    expect(extractTemplateParams("Hello {{ 1 }}!")).toEqual([1]);
  });

  it("returns empty for bodies without params", () => {
    expect(extractTemplateParams("static body")).toEqual([]);
    expect(extractTemplateParams("")).toEqual([]);
  });

  it("ignores non-numeric or zero placeholders", () => {
    expect(extractTemplateParams("{{name}} {{0}} {{-1}} {{3}}")).toEqual([3]);
  });
});

describe("previewTemplateBody", () => {
  it("substitutes default sample placeholders", () => {
    expect(previewTemplateBody("Hi {{1}}, order {{2}}")).toBe("Hi [param 1], order [param 2]");
  });

  it("uses provided sample values", () => {
    expect(previewTemplateBody("Hi {{1}}!", { 1: "Ada" })).toBe("Hi Ada!");
  });
});

describe("waTemplateStatusBadge", () => {
  it("maps known statuses", () => {
    expect(waTemplateStatusBadge("APPROVED").label).toBe("Approved");
    expect(waTemplateStatusBadge("PENDING").label).toBe("Pending");
    expect(waTemplateStatusBadge("REJECTED").label).toBe("Rejected");
  });

  it("falls back for unknown statuses", () => {
    expect(waTemplateStatusBadge("IN_APPEAL").label).toBe("IN_APPEAL");
    expect(waTemplateStatusBadge("").label).toBe("Unknown");
  });
});

describe("waQualityBadge", () => {
  it("maps HIGH/MEDIUM/LOW", () => {
    expect(waQualityBadge("HIGH").label).toBe("High");
    expect(waQualityBadge("MEDIUM").label).toBe("Medium");
    expect(waQualityBadge("LOW").label).toBe("Low");
  });

  it("falls back to Unknown", () => {
    expect(waQualityBadge("UNKNOWN").label).toBe("Unknown");
  });
});

describe("notifStatusGlyph", () => {
  it("uses whatsapp-style glyphs per status", () => {
    expect(notifStatusGlyph("sent").glyph).toBe("✓");
    expect(notifStatusGlyph("delivered").glyph).toBe("✓✓");
    expect(notifStatusGlyph("read").glyph).toBe("✓✓");
    expect(notifStatusGlyph("failed").glyph).toBe("⚠");
    expect(notifStatusGlyph("dead").glyph).toBe("✖");
  });

  it("distinguishes read from delivered by colour", () => {
    expect(notifStatusGlyph("read").className).not.toBe(notifStatusGlyph("delivered").className);
  });

  it("defaults to pending", () => {
    expect(notifStatusGlyph("pending").label).toBe("Pending");
    expect(notifStatusGlyph("whatever").label).toBe("Pending");
  });
});

describe("receiptTimestamp", () => {
  it("reads timestamps from the JSON blob", () => {
    const ts = { delivered: "2025-01-01T00:00:00Z" };
    expect(receiptTimestamp(ts, "delivered")).toBe("2025-01-01T00:00:00Z");
    expect(receiptTimestamp(ts, "read")).toBeNull();
  });

  it("handles missing/invalid blobs", () => {
    expect(receiptTimestamp(null, "sent")).toBeNull();
    expect(receiptTimestamp("nope", "sent")).toBeNull();
    expect(receiptTimestamp({ sent: 42 }, "sent")).toBeNull();
  });
});
