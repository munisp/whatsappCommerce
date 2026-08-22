/**
 * W27 catalog-ai unit tests — pure helpers + deterministic mock adapters.
 * No DB, no network: STT/vision are mocked, LLM is never called.
 */
import { describe, it, expect } from "vitest";
import {
  buildDraftButtonId,
  parseDraftButtonId,
  centsToDecimal,
  medianCents,
  priceBand,
  normalizeExtraction,
  mockSttAdapter,
  mockVisionAdapter,
  buildDraftInteractive,
  type CatalogAiDraft,
} from "./catalogAI";

describe("medianCents", () => {
  it("returns null for empty/non-integer input", () => {
    expect(medianCents([])).toBeNull();
    expect(medianCents([1.5, -2] as number[])).toBeNull();
  });
  it("odd count → middle value", () => {
    expect(medianCents([500, 100, 300])).toBe(300);
  });
  it("even count → integer average of middle two", () => {
    expect(medianCents([100, 200, 300, 401])).toBe(250);
  });
  it("is deterministic regardless of input order", () => {
    expect(medianCents([900, 100, 500])).toBe(medianCents([100, 500, 900]));
  });
});

describe("priceBand", () => {
  it("null when empty", () => expect(priceBand([])).toBeNull());
  it("single value → low == high", () => {
    expect(priceBand([700])).toEqual({ low: 700, high: 700 });
  });
  it("quartiles of a sorted set", () => {
    const band = priceBand([100, 200, 300, 400, 500, 600, 700, 800]);
    expect(band!.low).toBe(300);
    expect(band!.high).toBe(700);
  });
});

describe("centsToDecimal", () => {
  it("formats integer cents as decimal string", () => {
    expect(centsToDecimal(2500)).toBe("25.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(0)).toBe("0.00");
  });
});

describe("normalizeExtraction", () => {
  it("keeps integer cents prices", () => {
    const e = normalizeExtraction({ name: " Indomie 70g ", description: "Noodles", category: "groceries", priceCents: 3500 });
    expect(e).toEqual({ name: "Indomie 70g", description: "Noodles", category: "groceries", priceCents: 3500 });
  });
  it("rejects non-integer/negative prices and defaults category", () => {
    const e = normalizeExtraction({ name: "X", description: "", priceCents: 10.5 });
    expect(e.priceCents).toBeNull();
    expect(e.category).toBe("other");
    const e2 = normalizeExtraction({ name: "X", description: "", priceCents: -100 });
    expect(e2.priceCents).toBeNull();
  });
  it("clamps over-long fields", () => {
    const e = normalizeExtraction({ name: "n".repeat(500), description: "d", category: "c".repeat(200), priceCents: null });
    expect(e.name.length).toBe(255);
    expect(e.category.length).toBe(100);
  });
});

describe("draft button ids", () => {
  it("round-trips publish/reject ids", () => {
    const id = buildDraftButtonId("publish", "abc-123");
    expect(id).toBe("catalog_ai:publish:abc-123");
    expect(parseDraftButtonId(id)).toEqual({ action: "publish", draftId: "abc-123" });
    expect(parseDraftButtonId(buildDraftButtonId("reject", "x"))!.action).toBe("reject");
  });
  it("rejects foreign/invalid ids", () => {
    expect(parseDraftButtonId("menu_3")).toBeNull();
    expect(parseDraftButtonId("catalog_ai:")).toBeNull();
    expect(parseDraftButtonId("catalog_ai:edit:abc")).toBeNull();
    expect(parseDraftButtonId("catalog_ai:publish:")).toBeNull();
    expect(parseDraftButtonId("order_confirm:1")).toBeNull();
  });
});

describe("mock adapters", () => {
  it("mockSttAdapter yields scripted transcripts then fails soft", async () => {
    const stt = mockSttAdapter(["hello product", null]);
    expect((await stt.transcribe({ audio: Buffer.from("a") })).text).toBe("hello product");
    expect((await stt.transcribe({ audio: Buffer.from("a") })).text).toBeNull();
    expect((await stt.transcribe({ audio: Buffer.from("a") })).error).toBe("mock_empty");
  });
  it("mockVisionAdapter returns the scripted analysis", async () => {
    const v = mockVisionAdapter({ title: "Rice 50kg", description: "Bag of rice", category: "groceries", priceCents: 7500000, confidence: 90 });
    const r = await v.analyzeProductPhoto({ imageBase64: "AAAA", mimeType: "image/jpeg" });
    expect(r.title).toBe("Rice 50kg");
    expect(r.priceCents).toBe(7500000);
  });
});

describe("buildDraftInteractive", () => {
  const draft = {
    id: "d1", source: "voice", name: "Peak Milk 400g", description: "Tin milk",
    category: "groceries", suggestedPriceCents: 185000, priceBandLowCents: 150000,
    priceBandHighCents: 200000, currency: "NGN",
  } as unknown as CatalogAiDraft;
  it("renders summary with both buttons", () => {
    const i = buildDraftInteractive(draft);
    expect(i.bodyText).toContain("Peak Milk 400g");
    expect(i.bodyText).toContain("NGN 1850.00");
    expect(i.bodyText).toContain("NGN 1500.00 – NGN 2000.00");
    expect(i.action.buttons).toHaveLength(2);
    expect(i.action.buttons[0].id).toBe("catalog_ai:publish:d1");
    expect(i.action.buttons[1].id).toBe("catalog_ai:reject:d1");
  });
});
