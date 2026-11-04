import { describe, expect, it } from "vitest";
import { isNearbyQuestion, looksLikeStoreName } from "./services/platformInbound";

describe("shared-number directory wording", () => {
  it("reads questions about what's around as a request for nearby stores", () => {
    for (const t of ["Which available item is around me", "what's available near me", "What stores are near me?", "show me shops",
      "stores", "near me", "Any shops around?", "What can I buy", "what do you have"]) {
      expect(isNearbyQuestion(t), t).toBe(true);
    }
  });
  it("keeps product searches as product searches", () => {
    for (const t of ["Perfume", "toothpaste", "2 bags of rice", "Freaks fashion hub", "milo"]) {
      expect(isNearbyQuestion(t), t).toBe(false);
    }
  });
  it("spots business names", () => {
    expect(looksLikeStoreName("Freaks fashion hub")).toBe(true);
    expect(looksLikeStoreName("Mama Put Kitchen")).toBe(true);
    expect(looksLikeStoreName("Perfume")).toBe(false);
    expect(looksLikeStoreName("toothpaste")).toBe(false);
  });
});
