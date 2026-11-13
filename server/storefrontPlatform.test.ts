import { describe, expect, it } from "vitest";
import { applyTemplate, moveSection, section, storeConfigSchema, type StoreConfig } from "../shared/storefront/config";
import { ALL_TEMPLATES, findTemplate, STORE_TEMPLATES, TEMPLATE_CATEGORIES } from "../shared/storefront/templates";
import { demoProducts } from "../shared/storefront/demoCatalog";
import { hashPassword, storeCookieName, verifyPassword } from "./services/storefront/accounts";
import { normalizePhone } from "./services/storefront/checkout";
import { categoriesOf, checkoutOptions, queryCatalog, resolveWhatsapp, resolveWhatsappNumber } from "./services/storefront/store";
import { parseShopDirective } from "./services/platformNumber";
import { hasSessionCookie } from "./_core/csrf";

const base = () => structuredClone(findTemplate("market-square")!.config);

describe("store templates", () => {
  it("are at least 20 distinct designs covering every requested category", () => {
    expect(STORE_TEMPLATES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(STORE_TEMPLATES.map((t) => t.id)).size).toBe(STORE_TEMPLATES.length);
    for (const category of TEMPLATE_CATEGORIES) expect(STORE_TEMPLATES.some((t) => t.category === category)).toBe(true);
    const structure = (c: StoreConfig) => [c.header.variant, c.footer.variant, c.product.card, c.sections.map((s) => `${s.type}:${s.variant}`).join(">")].join("|");
    expect(new Set(STORE_TEMPLATES.map((t) => structure(t.config))).size).toBe(STORE_TEMPLATES.length);
  });

  it("every template is valid and every sample catalogue has products", () => {
    for (const t of ALL_TEMPLATES) {
      expect(storeConfigSchema.safeParse(t.config).success).toBe(true);
      expect(demoProducts(t.demo).length).toBeGreaterThan(3);
    }
  });

  it("contain no shop's data: no contact details and no invented reviews", () => {
    for (const t of ALL_TEMPLATES) {
      expect(Object.values(t.config.contact).filter(Boolean)).toEqual([]);
      for (const s of t.config.sections.filter((x) => x.type === "testimonials")) expect(s.items).toEqual([]);
    }
  });

  it("blank starts with a single section and the same shopping features", () => {
    const blank = findTemplate("blank")!.config;
    expect(blank.sections).toHaveLength(1);
    expect(blank.sections[0]?.type).toBe("products");
  });
});

describe("store config safety", () => {
  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example", "http://plain.example"])("rejects the link %s", (href) => {
    const config = base();
    config.sections[0]!.ctaHref = href;
    expect(storeConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each(["products", "products?sale=1", "whatsapp", "policy/returns", "/shop/x", "https://x.example", "mailto:a@b.co", "tel:+234", ""])("allows the link %s", (href) => {
    const config = base();
    config.sections[0]!.ctaHref = href;
    expect(storeConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects script-like images and colours", () => {
    const image = base();
    image.logoUrl = "javascript:alert(1)";
    expect(storeConfigSchema.safeParse(image).success).toBe(false);
    const colour = base();
    colour.theme.accent = "red;background:url(x)";
    expect(storeConfigSchema.safeParse(colour).success).toBe(false);
  });

  it("caps sections, so one save can't balloon the public page", () => {
    const config = base();
    config.sections = Array.from({ length: 41 }, (_, i) => section("text", `t${i}`));
    expect(storeConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("applying a template", () => {
  it("replaces the design and keeps what the merchant told us about their business", () => {
    const current = base();
    current.logoUrl = "/api/storage/tenant-branding/t/logo.png";
    current.storeName = "Ada's";
    current.contact.whatsapp = "2348012345678";
    current.policies.returns = "14 days";
    const next = applyTemplate(findTemplate("buka")!.config, current);
    expect(next.templateId).toBe("buka");
    expect(next.product.card).toBe("menu");
    expect(next.logoUrl).toBe(current.logoUrl);
    expect(next.storeName).toBe("Ada's");
    expect(next.contact.whatsapp).toBe("2348012345678");
    expect(next.policies.returns).toBe("14 days");
  });
  it("doesn't change the shared template object", () => {
    const before = JSON.stringify(findTemplate("buka")!.config);
    applyTemplate(findTemplate("buka")!.config, base());
    expect(JSON.stringify(findTemplate("buka")!.config)).toBe(before);
  });
});

describe("moveSection", () => {
  it("moves, and ignores out-of-range moves", () => {
    expect(moveSection(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveSection(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveSection(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("WhatsApp number", () => {
  const config = base();
  it("prefers the number set for the store, then the connected number, as digits", () => {
    expect(resolveWhatsappNumber({ ...config, contact: { ...config.contact, whatsapp: "2348011111111" } }, { whatsapp: { displayPhoneNumber: "+234 802 222 2222" } })).toBe("2348011111111");
    expect(resolveWhatsappNumber(config, { whatsapp: { displayPhoneNumber: "+234 802 222 2222" } })).toBe("2348022222222");
  });
  it("never uses Meta's phone number ID, and gives nothing rather than a dead link", () => {
    expect(resolveWhatsappNumber(config, { whatsappPhoneNumberId: "109876543210987" })).toBeNull();
    expect(resolveWhatsappNumber(config, {})).toBeNull();
  });
});

describe("shared WhatsApp number", () => {
  const config = base();
  const shop = { settings: {}, slug: "ada-fabrics", whatsappPhoneNumberId: null };
  it("is the default for a shop with no number, carrying the shop's identity", () => {
    expect(resolveWhatsapp(config, shop, "+234 700 000 0000")).toEqual({ number: "2347000000000", shopRef: "ada-fabrics", shared: true });
  });
  it("gives way to the shop's own number, without the routing line", () => {
    expect(resolveWhatsapp({ ...config, contact: { ...config.contact, whatsapp: "2348011111111" } }, shop, "2347000000000")).toEqual({ number: "2348011111111", shopRef: null, shared: false });
  });
  it("is not used for a shop on its own line, which the shared number can't route to", () => {
    expect(resolveWhatsapp(config, { ...shop, whatsappPhoneNumberId: "123" }, "2347000000000").number).toBeNull();
  });
  it("gives nothing when no shared number is configured", () => {
    expect(resolveWhatsapp(config, shop, "").number).toBeNull();
  });
  it("reads the shop and the customer's own message from a store link", () => {
    expect(parseShopDirective("Shop: ada-fabrics\nHello! I'm interested in Ankara.\nSize M")).toEqual({ ref: "ada-fabrics", rest: "Hello! I'm interested in Ankara.\nSize M" });
    expect(parseShopDirective("shop: ADA-Fabrics")).toEqual({ ref: "ada-fabrics", rest: "" });
  });
  it.each(["I want a shop: nice one", "shop: two words here", "shop:", "Hello", ""])("leaves ordinary messages alone: %s", (text) => {
    expect(parseShopDirective(text)).toBeNull();
  });
});

describe("checkout options", () => {
  it("follow the shop's settings", () => {
    expect(checkoutOptions({ commerce: { codEnabled: false, pickupEnabled: false } })).toEqual({ pickup: false, cod: false });
    expect(checkoutOptions({})).toEqual({ pickup: true, cod: true });
  });
});

describe("normalizePhone", () => {
  it.each([["08012345678", "2348012345678"], ["+234 801 234 5678", "2348012345678"], ["002348012345678", "2348012345678"]])("%s", (raw, out) => expect(normalizePhone(raw)).toBe(out));
  it.each(["123", "not a phone", ""])("rejects %s", (raw) => expect(normalizePhone(raw)).toBeNull());
});

describe("catalog search", () => {
  const p = (name: string, price: number, extra: object = {}) => ({ name, description: null, category: "A", price: price.toFixed(2), compareAtPrice: null, inStock: true, sold: 0, featured: false, isNew: false, ...extra });
  const all = [p("Red shoe", 300, { sold: 5 }), p("Blue shoe", 100, { category: "B", compareAtPrice: "150.00" }), p("Green hat", 200, { inStock: false, featured: true })];
  it("searches every word, filters and sorts", () => {
    expect(queryCatalog(all, { q: "red SHOE" }).items.map((x) => x.name)).toEqual(["Red shoe"]);
    expect(queryCatalog(all, { category: "B" }).total).toBe(1);
    expect(queryCatalog(all, { onSale: true }).items[0]?.name).toBe("Blue shoe");
    expect(queryCatalog(all, { inStock: true }).total).toBe(2);
    expect(queryCatalog(all, { minPrice: 150, maxPrice: 250 }).items[0]?.name).toBe("Green hat");
    expect(queryCatalog(all, { sort: "price_asc" }).items.map((x) => x.price)).toEqual(["100.00", "200.00", "300.00"]);
    expect(queryCatalog(all, { sort: "popular" }).items[0]?.name).toBe("Red shoe");
    expect(queryCatalog(all, {}).items[0]?.name).toBe("Green hat");
  });
  it("pages", () => {
    const page = queryCatalog(all, { page: 2, pageSize: 2 });
    expect(page).toMatchObject({ total: 3, pageCount: 2, page: 2 });
    expect(page.items).toHaveLength(1);
  });
  it("lists categories with counts", () => {
    expect(categoriesOf([{ category: "A", imageUrl: null }, { category: "A", imageUrl: "x" }, { category: null, imageUrl: null }])).toEqual([{ name: "A", imageUrl: "x", count: 2 }]);
  });
});

describe("customer accounts", () => {
  it("hash passwords with a unique salt and verify them", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct");
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
  it("use a different cookie for each store", () => {
    expect(storeCookieName("tenant-a")).not.toBe(storeCookieName("tenant-b"));
  });
  it("store cookies get the same cross-site protection as staff sessions", () => {
    const withCookie = (cookie: string) => ({ headers: { cookie } }) as Parameters<typeof hasSessionCookie>[0];
    expect(hasSessionCookie(withCookie(`theme=x; ${storeCookieName("t")}=abc`))).toBe(true);
    expect(hasSessionCookie(withCookie("theme=x"))).toBe(false);
  });
});

describe("product options", () => {
  it("offers naira first and by default, and far more categories than the grocery list", async () => {
    const { DEFAULT_PRODUCT_CURRENCY, PRODUCT_CATEGORIES, PRODUCT_CURRENCIES } = await import("../shared/productOptions");
    expect(DEFAULT_PRODUCT_CURRENCY).toBe("NGN");
    expect(PRODUCT_CURRENCIES[0]?.code).toBe("NGN");
    expect(PRODUCT_CATEGORIES.length).toBeGreaterThan(40);
    expect(new Set(PRODUCT_CATEGORIES).size).toBe(PRODUCT_CATEGORIES.length);
  });
});
