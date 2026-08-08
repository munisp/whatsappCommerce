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
  menuEntryReplyId,
  parseMenuEntryReplyId,
  renderMenu,
  renderUssdMenu,
  renderWhatsAppInteractive,
  renderWhatsAppMenu,
  resolveMenuSelection,
  ussdWrap,
  type WaMenuConfig,
} from "./services/waMenu";
import { DEFAULT_WA_MENU, renderWaMenu } from "../shared/waMenu";

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
    expect(text).toContain("1. Shop products");
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
    // Default menu keeps support/booking disabled → entry 3 is handoff.
    expect(resolveMenuSelection(config, " 3 ")?.id).toBe("handoff");
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

describe("renderer unification (shared/waMenu.ts is the source of truth)", () => {
  it("defaultMenuConfig is a deep copy of shared DEFAULT_WA_MENU", () => {
    expect(defaultMenuConfig()).toEqual(DEFAULT_WA_MENU);
    expect(defaultMenuConfig()).not.toBe(DEFAULT_WA_MENU);
    expect(defaultMenuConfig().useCases).not.toBe(DEFAULT_WA_MENU.useCases);
  });

  it("runtime renderMenu matches shared renderWaMenu for the same config", () => {
    const config = loadMenuConfig({
      settings: {
        waMenu: {
          greeting: "Karibu to {businessName}!",
          useCases: [
            { id: "track", label: "Order status", enabled: true, order: 1 },
            { id: "shop", label: "Buy something", enabled: true, order: 2 },
            { id: "support", label: "Help", enabled: false, order: 3 },
          ],
          customItems: [{ key: "hours", label: "Opening hours", response: "9-5" }],
          fallback: "nlp",
        },
      },
    });
    expect(renderMenu(config, { businessName: "Ada Stores" })).toBe(
      renderWaMenu(config, { businessName: "Ada Stores" }),
    );
    // …including the live open-order count annotation.
    expect(renderMenu(config, { businessName: "Ada Stores", openOrdersCount: 2 })).toBe(
      renderWaMenu(config, { businessName: "Ada Stores", openOrderCount: 2 }),
    );
    expect(renderMenu(config, { businessName: "Ada Stores", openOrdersCount: 2 })).toContain(
      "1. Order status (2 open)",
    );
  });
});

describe("renderWhatsAppInteractive", () => {
  const configWith = (useCases: WaMenuConfig["useCases"], customItems: WaMenuConfig["customItems"] = []): WaMenuConfig => ({
    greeting: "Welcome to {businessName}!",
    useCases,
    customItems,
    fallback: "nlp",
  });

  it("≤3 entries → reply buttons with menu_<n> ids", () => {
    const out = renderWhatsAppInteractive(defaultMenuConfig(), { businessName: "Ada Stores" });
    expect(out?.action.type).toBe("button");
    if (out?.action.type !== "button") return;
    expect(out.action.buttons.map((b) => b.id)).toEqual(["menu_1", "menu_2", "menu_3"]);
    expect(out.action.buttons[0].title).toBe("Shop products");
    expect(out.bodyText).toBe("Welcome to Ada Stores! How can we help you today?");
  });

  it("4–10 entries → a single-section list", () => {
    const config = configWith(
      [
        { id: "shop", label: "Shop", enabled: true, order: 1 },
        { id: "track", label: "Track", enabled: true, order: 2 },
        { id: "support", label: "Support", enabled: true, order: 3 },
        { id: "booking", label: "Book", enabled: true, order: 4 },
        { id: "handoff", label: "Human", enabled: true, order: 5 },
      ],
      [{ key: "hours", label: "Hours", response: "9-5" }],
    );
    const out = renderWhatsAppInteractive(config, {});
    expect(out?.action.type).toBe("list");
    if (out?.action.type !== "list") return;
    expect(out.action.sections).toHaveLength(1);
    expect(out.action.sections[0].rows).toHaveLength(6);
    expect(out.action.sections[0].rows[5]).toMatchObject({ id: "menu_6", title: "Hours" });
  });

  it(">10 entries → null (caller falls back to the numbered text menu)", () => {
    const config = configWith(
      [{ id: "shop", label: "Shop", enabled: true, order: 1 }],
      Array.from({ length: 10 }, (_, i) => ({ key: `c${i}`, label: `Custom ${i}`, response: "x" })),
    );
    expect(buildMenuEntries(config)).toHaveLength(11);
    expect(renderWhatsAppInteractive(config, {})).toBeNull();
  });

  it("menu entry reply ids round-trip to the same selection as numeric replies", () => {
    const config = defaultMenuConfig();
    for (const entry of buildMenuEntries(config)) {
      const id = menuEntryReplyId(entry);
      expect(parseMenuEntryReplyId(id)).toBe(entry.n);
      expect(resolveMenuSelection(config, String(parseMenuEntryReplyId(id)))?.id).toBe(entry.id);
    }
    expect(parseMenuEntryReplyId("order_pay:abc")).toBeNull();
    expect(parseMenuEntryReplyId("menu_99")).toBe(99);
  });
});

describe("isMenuKeyword", () => {
  it("matches greeting/menu keywords case-insensitively", () => {
    for (const kw of ["menu", "MENU", " hi ", "Hello", "start", "restart", "help", "catalog"]) {
      expect(isMenuKeyword(kw)).toBe(true);
    }
    expect(isMenuKeyword("I want to buy bread")).toBe(false);
    expect(isMenuKeyword("2")).toBe(false);
  });
});
