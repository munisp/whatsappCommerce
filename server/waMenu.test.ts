/**
 * waMenu — unit tests
 * Default template, custom config merge, ordering, numeric selection,
 * WhatsApp + USSD (CON/END) formatting over the same core renderer.
 */
import { describe, it, expect } from "vitest";
import {
  buildMenuEntries,
  defaultMenuConfig,
  isMenuKeyword,
  loadMenuConfig,
  renderMenu,
  renderUssdMenu,
  renderWhatsAppMenu,
  resolveMenuSelection,
  ussdWrap,
  type WaMenuConfig,
} from "./services/waMenu";

describe("loadMenuConfig", () => {
  it("returns the default template when settings.waMenu is absent", () => {
    const config = loadMenuConfig({ settings: null });
    expect(config).toEqual(defaultMenuConfig());
    expect(config.fallback).toBe("nlp");
    expect(config.useCases.map((u) => u.id)).toEqual(["shop", "track", "support", "booking", "handoff"]);
  });

  it("returns the default template for a null tenant", () => {
    expect(loadMenuConfig(null)).toEqual(defaultMenuConfig());
    expect(loadMenuConfig(undefined)).toEqual(defaultMenuConfig());
  });

  it("merges a stored custom config over the defaults", () => {
    const config = loadMenuConfig({
      settings: {
        waMenu: {
          greeting: "Karibu to {businessName}!",
          fallback: "menu",
          useCases: [
            { id: "track", label: "Order status", enabled: true, order: 1 },
            { id: "shop", label: "Buy something", enabled: true, order: 2 },
            { id: "support", label: "Help", enabled: false, order: 3 },
          ],
          customItems: [{ key: "hours", label: "Opening hours", response: "We are open 9-5." }],
        },
      },
    });
    expect(config.greeting).toBe("Karibu to {businessName}!");
    expect(config.fallback).toBe("menu");
    expect(config.useCases).toHaveLength(3);
    expect(config.customItems).toHaveLength(1);
  });

  it("drops malformed entries and falls back when useCases is invalid", () => {
    const config = loadMenuConfig({
      settings: { waMenu: { useCases: [{ id: "nonsense" }, { id: "shop", label: "Shop", enabled: true, order: 1 }] } },
    });
    expect(config.useCases).toHaveLength(1);
    expect(config.useCases[0].id).toBe("shop");
    const allBad = loadMenuConfig({ settings: { waMenu: { useCases: [{ id: "nonsense" }] } } });
    expect(allBad.useCases).toEqual(defaultMenuConfig().useCases);
  });
});

describe("buildMenuEntries + renderMenu ordering", () => {
  it("numbers enabled useCases sorted by order, then customItems", () => {
    const config: WaMenuConfig = {
      greeting: "Hi from {businessName}",
      fallback: "nlp",
      useCases: [
        { id: "support", label: "Support", enabled: true, order: 20 },
        { id: "shop", label: "Shop", enabled: true, order: 10 },
        { id: "track", label: "Track", enabled: false, order: 5 }, // disabled → hidden
        { id: "booking", label: "Book", enabled: true, order: 30 },
        { id: "handoff", label: "Human", enabled: true, order: 40 },
      ],
      customItems: [
        { key: "hours", label: "Hours", response: "9-5" },
        { key: "location", label: "Location", response: "Lagos" },
      ],
    };
    const entries = buildMenuEntries(config);
    expect(entries.map((e) => [e.n, e.id])).toEqual([
      [1, "shop"],
      [2, "support"],
      [3, "booking"],
      [4, "handoff"],
      [5, "hours"],
      [6, "location"],
    ]);
    const text = renderMenu(config, { businessName: "Ada Stores" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Hi from Ada Stores");
    expect(text).toContain("1. Shop");
    expect(text).toContain("6. Location");
    expect(text).not.toContain("Track");
  });

  it("interpolates {businessName} and {openOrders} placeholders", () => {
    const config = defaultMenuConfig();
    config.useCases = [{ id: "track", label: "Track ({openOrders} open)", enabled: true, order: 1 }];
    const text = renderMenu(config, { businessName: "Kemi's Kitchen", openOrdersCount: 3 });
    expect(text).toContain("Welcome to Kemi's Kitchen");
    expect(text).toContain("1. Track (3 open)");
  });
});

describe("channel formatters", () => {
  it("WhatsApp formatter appends a reply hint", () => {
    const text = renderWhatsAppMenu(defaultMenuConfig(), { businessName: "Shop" });
    expect(text).toContain("1. Shop / place an order");
    expect(text).toMatch(/Reply with a number/);
  });

  it("USSD formatter prefixes CON (continue) and END (terminal)", () => {
    const config = defaultMenuConfig();
    expect(renderUssdMenu(config, {})).toMatch(/^CON /);
    expect(renderUssdMenu(config, {}, { end: true })).toMatch(/^END /);
    expect(ussdWrap("done", true)).toBe("END done");
    expect(ussdWrap("more?", false)).toBe("CON more?");
  });
});

describe("resolveMenuSelection", () => {
  it("resolves numeric input against the rendered entries", () => {
    const config = defaultMenuConfig();
    expect(resolveMenuSelection(config, "1")?.id).toBe("shop");
    expect(resolveMenuSelection(config, "2")?.id).toBe("track");
    expect(resolveMenuSelection(config, " 3 ")?.id).toBe("support");
  });

  it("returns null for out-of-range or non-numeric input", () => {
    const config = defaultMenuConfig();
    expect(resolveMenuSelection(config, "99")).toBeNull();
    expect(resolveMenuSelection(config, "shop please")).toBeNull();
    expect(resolveMenuSelection(config, "")).toBeNull();
  });

  it("selects custom items by their sequential number", () => {
    const config = loadMenuConfig({
      settings: {
        waMenu: {
          useCases: [{ id: "shop", label: "Shop", enabled: true, order: 1 }],
          customItems: [{ key: "hours", label: "Hours", response: "9-5" }],
        },
      },
    });
    const sel = resolveMenuSelection(config, "2");
    expect(sel?.kind).toBe("custom");
    expect(sel?.id).toBe("hours");
  });
});

describe("isMenuKeyword", () => {
  it("matches greeting/menu keywords case-insensitively", () => {
    for (const kw of ["menu", "MENU", " hi ", "Hello", "start", "restart", "help"]) {
      expect(isMenuKeyword(kw)).toBe(true);
    }
    expect(isMenuKeyword("I want to buy bread")).toBe(false);
    expect(isMenuKeyword("2")).toBe(false);
  });
});
