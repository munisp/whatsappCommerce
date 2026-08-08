/**
 * i18n — unit tests
 * Locale detection heuristic, sticky per-customer locale (memory fallback),
 * tenant default, and localized menu chrome rendering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => null) }));

import {
  detectLocale,
  setStickyLocale,
  getStickyLocale,
  resolveLocale,
  localizeMenuConfig,
  localeFromSessionLanguage,
  tr,
  __clearMemoryLocales,
} from "./services/i18n";
import { defaultMenuConfig, renderWhatsAppMenu } from "./services/waMenu";

beforeEach(() => __clearMemoryLocales());

describe("detectLocale", () => {
  it("detects French", () => {
    expect(detectLocale("Bonjour, je veux passer une commande")).toBe("fr");
    expect(detectLocale("Quel est le prix de la livraison ?")).toBe("fr");
  });

  it("detects Hausa", () => {
    expect(detectLocale("Sannu! Nawa ne kudin wannan?")).toBe("ha");
    expect(detectLocale("Ina son sayayya, don Allah")).toBe("ha");
  });

  it("detects Yoruba", () => {
    expect(detectLocale("Bawo ni owo ọjà yii?")).toBe("yo");
    expect(detectLocale("Mo fe ra ọjà")).toBe("yo");
  });

  it("detects Igbo", () => {
    expect(detectLocale("Kedu ego ihe a?")).toBe("ig");
    expect(detectLocale("Biko, ị nwere ike izitere m ngọdo")).toBe("ig");
  });

  it("defaults to English for plain English / empty text", () => {
    expect(detectLocale("2 spicy wraps and a malt please")).toBe("en");
    expect(detectLocale("")).toBe("en");
    expect(detectLocale("checkout")).toBe("en");
  });
});

describe("sticky locale", () => {
  it("persists and reads back the caller's locale", async () => {
    expect(await getStickyLocale("t1", "2348000000001")).toBeNull();
    await setStickyLocale("t1", "2348000000001", "yo");
    expect(await getStickyLocale("t1", "2348000000001")).toBe("yo");
  });

  it("is tenant-scoped (no cross-tenant leakage)", async () => {
    await setStickyLocale("t1", "2348000000002", "ha");
    expect(await getStickyLocale("t2", "2348000000002")).toBeNull();
    expect(await getStickyLocale("t1", "2348000000002")).toBe("ha");
  });

  it("falls back to a provided customers.language value", async () => {
    expect(await getStickyLocale("t1", "2348000000003", { customerLanguage: "ig" })).toBe("ig");
    expect(await getStickyLocale("t1", "2348000000003", { customerLanguage: "klingon" })).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("sticky locale wins over text detection", async () => {
    await setStickyLocale("t1", "p1", "fr");
    expect(await resolveLocale({ tenantId: "t1", phone: "p1", text: "sannu barka" })).toBe("fr");
  });

  it("detects from text and makes it sticky", async () => {
    expect(await resolveLocale({ tenantId: "t1", phone: "p2", text: "Sannu! Nawa ne?" })).toBe("ha");
    expect(await getStickyLocale("t1", "p2")).toBe("ha");
  });

  it("falls back to the tenant default from settings.locale", async () => {
    expect(
      await resolveLocale({ tenantId: "t1", phone: "p3", text: "hello there", tenantSettings: { locale: "yo" } }),
    ).toBe("yo");
  });

  it("defaults to English otherwise", async () => {
    expect(await resolveLocale({ tenantId: "t1", phone: "p4", text: "hello there" })).toBe("en");
  });
});

describe("localized menu render", () => {
  it("translates the default menu chrome to French", () => {
    const localized = localizeMenuConfig(defaultMenuConfig(), "fr");
    const rendered = renderWhatsAppMenu(localized, { businessName: "Ada Stores" });
    expect(rendered).toContain("Bienvenue chez Ada Stores");
    expect(rendered).toContain("Suivre ma commande");
    expect(rendered).toContain("Parler à un agent");
  });

  it("preserves tenant-customized text verbatim", () => {
    const config = defaultMenuConfig();
    config.greeting = "Karibu to my shop!";
    const shop = config.useCases.find((u) => u.id === "shop")!;
    shop.label = "BUY NOW!!!";
    const localized = localizeMenuConfig(config, "ha");
    expect(localized.greeting).toBe("Karibu to my shop!");
    expect(localized.useCases.find((u) => u.id === "shop")!.label).toBe("BUY NOW!!!");
    // Untouched default labels still translate.
    expect(localized.useCases.find((u) => u.id === "track")!.label).toBe("Bibiyar odana");
  });

  it("returns the config unchanged for English", () => {
    const config = defaultMenuConfig();
    expect(localizeMenuConfig(config, "en")).toBe(config);
  });
});

describe("helpers", () => {
  it("maps NLP session language names to locale codes", () => {
    expect(localeFromSessionLanguage("yoruba")).toBe("yo");
    expect(localeFromSessionLanguage("hausa")).toBe("ha");
    expect(localeFromSessionLanguage("igbo")).toBe("ig");
    expect(localeFromSessionLanguage("pidgin")).toBe("en");
    expect(localeFromSessionLanguage("english")).toBe("en");
  });

  it("tr() falls back to English for unknown locales", () => {
    expect(tr("xx", "cartRecovery")).toContain("reply CHECKOUT");
    expect(tr("fr", "cartRecovery")).toContain("CHECKOUT");
  });
});
