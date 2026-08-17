/**
 * W16 template pre-approval library integrity tests: locale coverage,
 * placeholder/variable consistency, category policy rules, Meta-safe names.
 */
import { describe, it, expect } from "vitest";
import {
  bodyParams,
  getLibraryEntry,
  validateLibrary,
  WA_TEMPLATE_LIBRARY,
  WA_TEMPLATE_LOCALES,
} from "./services/waTemplates/library";

describe("WA template library integrity", () => {
  it("validateLibrary() reports zero issues for the shipped library", () => {
    expect(validateLibrary()).toEqual([]);
  });

  it("ships ~10 curated templates covering the required use cases", () => {
    expect(WA_TEMPLATE_LIBRARY.length).toBeGreaterThanOrEqual(10);
    const keys = WA_TEMPLATE_LIBRARY.map((t) => t.key);
    for (const required of [
      "order_confirmation",
      "payment_reminder",
      "delivery_update",
      "credit_repayment_reminder",
      "broadcast_opt_in",
    ]) {
      expect(keys).toContain(required);
    }
    expect(new Set(keys).size).toBe(keys.length); // unique keys
  });

  it("every template has a body for every supported locale (en/ha/yo/ig/pcm)", () => {
    for (const entry of WA_TEMPLATE_LIBRARY) {
      for (const locale of WA_TEMPLATE_LOCALES) {
        expect(entry.bodies[locale], `${entry.key}.${locale}`).toBeTruthy();
        expect(entry.bodies[locale].trim().length).toBeGreaterThan(10);
      }
    }
  });

  it("placeholders are contiguous {{1}}..{{n}} and match the variables list", () => {
    for (const entry of WA_TEMPLATE_LIBRARY) {
      for (const locale of WA_TEMPLATE_LOCALES) {
        const params = bodyParams(entry.bodies[locale]);
        expect(params, `${entry.key}.${locale}`).toEqual(
          entry.variables.map((_, i) => i + 1),
        );
      }
    }
  });

  it("names are Meta-safe (lowercase, digits, underscores)", () => {
    for (const entry of WA_TEMPLATE_LIBRARY) {
      expect(entry.name).toMatch(/^[a-z0-9_]{1,512}$/);
    }
  });

  it("categories are UTILITY or MARKETING only", () => {
    for (const entry of WA_TEMPLATE_LIBRARY) {
      expect(["UTILITY", "MARKETING"]).toContain(entry.category);
    }
  });

  it("MARKETING templates carry opt-out language in every locale", () => {
    const marketing = WA_TEMPLATE_LIBRARY.filter((t) => t.category === "MARKETING");
    expect(marketing.length).toBeGreaterThanOrEqual(2);
    for (const entry of marketing) {
      for (const locale of WA_TEMPLATE_LOCALES) {
        expect(entry.bodies[locale], `${entry.key}.${locale}`).toMatch(/stop|opt out|comot|ficewa|jade|pụọ/i);
      }
    }
  });

  it("UTILITY templates are transactional (both reminder types present)", () => {
    const utility = WA_TEMPLATE_LIBRARY.filter((t) => t.category === "UTILITY");
    expect(utility.length).toBeGreaterThanOrEqual(6);
  });

  it("getLibraryEntry finds known keys and returns undefined otherwise", () => {
    expect(getLibraryEntry("order_confirmation")?.category).toBe("UTILITY");
    expect(getLibraryEntry("broadcast_opt_in")?.category).toBe("MARKETING");
    expect(getLibraryEntry("nope")).toBeUndefined();
  });

  it("bodyParams extracts ordered deduped positional params", () => {
    expect(bodyParams("hi {{2}} and {{1}} and {{2}}")).toEqual([1, 2]);
    expect(bodyParams("no params")).toEqual([]);
  });
});
