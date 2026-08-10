/**
 * Shared waMenu pure helpers — unit tests.
 *
 * Covers the renderer moved to shared/waMenu.ts (used by both the server
 * preview service and the admin menu-builder draft preview) plus the draft
 * reorder helpers and the tenant domains schema.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_WA_MENU,
  moveUseCase,
  renumberUseCases,
  renderWaMenu,
  sortUseCasesByOrder,
  type WaMenuConfig,
} from "../shared/waMenu";
import { tenantDomainsSchema, tenantDomainSchema } from "../shared/tenantConfig";

function menu(patch: Partial<WaMenuConfig> = {}): WaMenuConfig {
  return { ...JSON.parse(JSON.stringify(DEFAULT_WA_MENU)), ...patch };
}

describe("renderWaMenu", () => {
  it("substitutes {businessName} and lists only enabled use cases in order", () => {
    const text = renderWaMenu(menu(), { businessName: "Ada Stores" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Welcome to Ada Stores! How can we help you today?");
    expect(lines).toContain("1. Shop products");
    expect(lines).toContain("2. Track my order");
    expect(lines).toContain("3. Talk to a human");
    expect(text).not.toContain("Get support");
    expect(text).not.toContain("Book an appointment");
  });

  it("annotates shop/track labels with live counts and top products", () => {
    const text = renderWaMenu(menu(), {
      businessName: "B",
      shopItemCount: 7,
      topProducts: ["Rice", "Beans", "Yam", "Garri", "Oil", "Sugar"],
      openOrderCount: 3,
    });
    expect(text).toContain("1. Shop products (7 items)");
    expect(text).toContain("2. Track my order (3 open)");
    // at most 5 product sub-lines
    expect(text).toContain("   • Oil");
    expect(text).not.toContain("   • Sugar");
  });

  it("numbers custom items after the enabled use cases", () => {
    const text = renderWaMenu(
      menu({ customItems: [{ key: "hours", label: "Opening hours", response: "9-5" }] }),
      { businessName: "B" },
    );
    expect(text).toContain("4. Opening hours");
  });

  it("renders an empty numbered list when everything is disabled", () => {
    const m = menu({ useCases: DEFAULT_WA_MENU.useCases.map((u) => ({ ...u, enabled: false })) });
    const text = renderWaMenu(m, { businessName: "B" });
    expect(text.split("\n").filter((l) => /^\d+\./.test(l))).toHaveLength(0);
  });
});

describe("use-case ordering helpers", () => {
  it("sortUseCasesByOrder sorts ascending without mutating the input", () => {
    const input = [
      { id: "track" as const, label: "T", enabled: true, order: 2 },
      { id: "shop" as const, label: "S", enabled: true, order: 1 },
    ];
    const sorted = sortUseCasesByOrder(input);
    expect(sorted.map((u) => u.id)).toEqual(["shop", "track"]);
    expect(input[0].id).toBe("track");
  });

  it("renumberUseCases rewrites order to 1..N following current sort", () => {
    const out = renumberUseCases([
      { id: "track" as const, label: "T", enabled: true, order: 5 },
      { id: "shop" as const, label: "S", enabled: true, order: 2 },
    ]);
    expect(out).toEqual([
      { id: "shop", label: "S", enabled: true, order: 1 },
      { id: "track", label: "T", enabled: true, order: 2 },
    ]);
  });

  it("moveUseCase swaps adjacent entries and renumbers", () => {
    const moved = moveUseCase(DEFAULT_WA_MENU.useCases, "support", "up");
    const ids = sortUseCasesByOrder(moved).map((u) => u.id);
    expect(ids).toEqual(["shop", "support", "track", "booking", "handoff", "procurement"]);
    expect(sortUseCasesByOrder(moved).map((u) => u.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("moveUseCase is a no-op at the boundaries and for unknown ids", () => {
    const first = moveUseCase(DEFAULT_WA_MENU.useCases, "shop", "up");
    expect(sortUseCasesByOrder(first).map((u) => u.id)).toEqual(
      DEFAULT_WA_MENU.useCases.map((u) => u.id),
    );
    const last = moveUseCase(DEFAULT_WA_MENU.useCases, "procurement", "down");
    expect(sortUseCasesByOrder(last).map((u) => u.id)).toEqual(
      DEFAULT_WA_MENU.useCases.map((u) => u.id),
    );
  });
});

describe("tenantDomainsSchema", () => {
  it("accepts valid hostnames and lowercases them", () => {
    expect(tenantDomainSchema.parse("Shop.Example.com")).toBe("shop.example.com");
    expect(tenantDomainsSchema.parse(["a.example.com", "b-shop.example.org"])).toEqual([
      "a.example.com",
      "b-shop.example.org",
    ]);
  });

  it("rejects invalid hosts, protocols and ports", () => {
    for (const bad of ["https://shop.example.com", "shop.example.com:8443", "localhost", "-bad.com", "bad..com", ""]) {
      expect(tenantDomainSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("rejects duplicates and caps the list at 20", () => {
    expect(tenantDomainsSchema.safeParse(["a.example.com", "A.example.com"]).success).toBe(false);
    const tooMany = Array.from({ length: 21 }, (_, i) => `d${i}.example.com`);
    expect(tenantDomainsSchema.safeParse(tooMany).success).toBe(false);
  });
});
