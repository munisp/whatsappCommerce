/**
 * W25 discoveryMenu unit tests — pure helpers, no DB.
 * Covers menu formatting (sponsored-first ordering, disclosure label, caps,
 * empty state), category menu + selection resolution (name and 1-based
 * index), and extractDiscoverQuery positives/negatives.
 */
import { describe, it, expect } from "vitest";
import {
  DISCOVERY_MENU_MAX_ORGANIC,
  extractDiscoverQuery,
  formatCategoryMenu,
  formatDiscoveryMenu,
  resolveCategorySelection,
} from "./discoveryMenu";
import type { CategoryNode, DiscoverItem } from "./geoDiscovery";

function item(partial: Partial<DiscoverItem> & { tenantId: string }): DiscoverItem {
  return {
    businessName: partial.tenantId,
    category: "Food",
    distanceKm: 1,
    sponsored: false,
    trustScore: null,
    rating: null,
    openNow: null,
    score: 0,
    ...partial,
  };
}

// ─── formatDiscoveryMenu ────────────────────────────────────────────────────
describe("formatDiscoveryMenu", () => {
  it("puts sponsored entries first with the disclosure prefix", () => {
    const menu = formatDiscoveryMenu([
      item({ tenantId: "a", businessName: "Organic One", distanceKm: 0.4 }),
      item({ tenantId: "b", businessName: "Paid Place", sponsored: true, distanceKm: 2.3 }),
      item({ tenantId: "c", businessName: "Organic Two", distanceKm: 1.1 }),
    ], 5);
    const lines = menu.split("\n");
    expect(lines[0]).toContain("within 5 km");
    expect(lines[1]).toMatch(/^1\. ★ Sponsored: Paid Place — Food · 2\.3 km$/);
    expect(lines[2]).toMatch(/^2\. Organic One — Food · 0\.4 km$/);
    expect(lines[3]).toMatch(/^3\. Organic Two — Food · 1\.1 km$/);
  });

  it("labels category and distance per line, with a fallback category", () => {
    const menu = formatDiscoveryMenu([
      item({ tenantId: "a", businessName: "NoCat", category: null, distanceKm: 12.34 }),
    ], 25);
    expect(menu).toContain("NoCat — Local business · 12 km");
  });

  it("caps organic entries at 10 but keeps all flagged sponsored entries", () => {
    const organic = Array.from({ length: 14 }, (_, i) =>
      item({ tenantId: `o${i}`, businessName: `Organic ${i}` }));
    const sponsored = [
      item({ tenantId: "s1", businessName: "Sponsored 1", sponsored: true }),
      item({ tenantId: "s2", businessName: "Sponsored 2", sponsored: true }),
    ];
    const menu = formatDiscoveryMenu([...organic, ...sponsored], 5);
    const rows = menu.split("\n").slice(1);
    expect(rows).toHaveLength(2 + DISCOVERY_MENU_MAX_ORGANIC);
    expect(rows[0]).toContain("★ Sponsored: Sponsored 1");
    expect(rows[1]).toContain("★ Sponsored: Sponsored 2");
    expect(rows.some((r) => r.includes("Organic 10"))).toBe(false);
  });

  it("has a friendly empty state mentioning the radius", () => {
    const menu = formatDiscoveryMenu([], 5);
    expect(menu).toContain("No businesses found within 5 km");
  });
});

// ─── formatCategoryMenu / resolveCategorySelection ──────────────────────────
const CATS: CategoryNode[] = [
  { id: "food & restaurants", name: "Food & Restaurants", subcategories: [{ id: "bakery", name: "Bakery" }, { id: "fast food", name: "Fast Food" }] },
  { id: "grocery", name: "Grocery", subcategories: [] },
  { id: "pharmacy", name: "Pharmacy", subcategories: [] },
];

describe("formatCategoryMenu", () => {
  it("numbers categories and previews subcategories", () => {
    const menu = formatCategoryMenu(CATS);
    expect(menu).toContain("1. Food & Restaurants (Bakery, Fast Food)");
    expect(menu).toContain("2. Grocery");
    expect(menu).toContain("3. Pharmacy");
  });
  it("has an empty-state message", () => {
    expect(formatCategoryMenu([])).toContain("No categories");
  });
});

describe("resolveCategorySelection", () => {
  it("resolves by 1-based index", () => {
    expect(resolveCategorySelection("1", CATS)).toBe("Food & Restaurants");
    expect(resolveCategorySelection(" 3 ", CATS)).toBe("Pharmacy");
    expect(resolveCategorySelection("4", CATS)).toBeNull();
    expect(resolveCategorySelection("0", CATS)).toBeNull();
  });
  it("resolves by name (case-insensitive) and subcategory name", () => {
    expect(resolveCategorySelection("grocery", CATS)).toBe("Grocery");
    expect(resolveCategorySelection("PHARMACY", CATS)).toBe("Pharmacy");
    expect(resolveCategorySelection("Bakery", CATS)).toBe("Food & Restaurants");
  });
  it("resolves partial containment for longer replies", () => {
    expect(resolveCategorySelection("grocery store", CATS)).toBe("Grocery");
  });
  it("returns null for unrelated text", () => {
    expect(resolveCategorySelection("hello there", CATS)).toBeNull();
    expect(resolveCategorySelection("", CATS)).toBeNull();
  });
});

// ─── extractDiscoverQuery ───────────────────────────────────────────────────
describe("extractDiscoverQuery", () => {
  it("detects bare intents and returns an empty query", () => {
    expect(extractDiscoverQuery("near me")).toBe("");
    expect(extractDiscoverQuery("what's nearby?")).toBe("");
    expect(extractDiscoverQuery("show me around me")).toBe("");
  });
  it("extracts the residual query", () => {
    expect(extractDiscoverQuery("find a pharmacy near me")).toBe("a pharmacy");
    expect(extractDiscoverQuery("restaurants near me")).toBe("restaurants");
    expect(extractDiscoverQuery("closest ATM")).toBe("atm");
    expect(extractDiscoverQuery("any salons nearby")).toBe("salons");
    expect(extractDiscoverQuery("where is the nearest fuel station")).toBe("fuel station");
  });
  it("returns null for non-discovery messages", () => {
    expect(extractDiscoverQuery("add 2 wraps to my cart")).toBeNull();
    expect(extractDiscoverQuery("where is my order")).toBeNull();
    expect(extractDiscoverQuery("hello")).toBeNull();
    expect(extractDiscoverQuery("")).toBeNull();
  });
});
