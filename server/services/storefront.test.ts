/**
 * W27 storefront service — pure-helper unit tests (hermetic, no DB).
 */
import { describe, expect, it } from "vitest";
import {
  buildDefaultSlug,
  SLUG_MAX_LEN,
  slugify,
  validateSlug,
} from "./storefront";

describe("slugify", () => {
  it("normalizes names to url-safe slugs", () => {
    expect(slugify("Adire Threads")).toBe("adire-threads");
    expect(slugify("  Kano  Grains & Co. ")).toBe("kano-grains-co");
    expect(slugify("Ébène Café")).toBe("ebene-cafe"); // diacritics stripped
  });
  it("falls back to 'shop' for empty/unusable names", () => {
    expect(slugify("")).toBe("shop");
    expect(slugify("!!!")).toBe("shop");
  });
  it("caps length at 60 chars without trailing hyphen", () => {
    const s = slugify("a".repeat(100));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    expect(validateSlug("adire-threads")).toBeNull();
    expect(validateSlug("shop1")).toBeNull();
    expect(validateSlug("a")).toBeNull();
  });
  it("rejects invalid slugs", () => {
    expect(validateSlug("")).toBeTruthy();
    expect(validateSlug("Bad Slug")).toBeTruthy();
    expect(validateSlug("-lead")).toBeTruthy();
    expect(validateSlug("trail-")).toBeTruthy();
    expect(validateSlug("UPPER")).toBeTruthy();
    expect(validateSlug("under_score")).toBeTruthy();
    expect(validateSlug("x".repeat(SLUG_MAX_LEN + 1))).toBeTruthy();
  });
});

describe("buildDefaultSlug", () => {
  it("is deterministic for the same tenant", () => {
    expect(buildDefaultSlug("t-1", "Adire Threads"))
      .toBe(buildDefaultSlug("t-1", "Adire Threads"));
  });
  it("differs across tenants (uniqueness suffix)", () => {
    const a = buildDefaultSlug("t-1", "Same Name");
    const b = buildDefaultSlug("t-2", "Same Name");
    expect(a).not.toBe(b);
    expect(a.startsWith("same-name-")).toBe(true);
    expect(b.startsWith("same-name-")).toBe(true);
  });
  it("produces valid slugs", () => {
    for (const t of ["t-1", "t-2", "t-3", "abc", "xyz"]) {
      expect(validateSlug(buildDefaultSlug(t, "Mama Nkechi's Shop"))).toBeNull();
    }
  });
});
