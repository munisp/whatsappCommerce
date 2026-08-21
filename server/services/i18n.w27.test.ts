/**
 * W27 i18n framework — unit tests (hermetic, no DB).
 *
 * Covers: the 7-locale extension (sw/am packs), message catalog fallback
 * chain locale→en, {var} interpolation, language picker parsing, and the
 * locale-aware NLU keyword map.
 */
import { describe, expect, it } from "vitest";
import {
  buildLanguageMenu,
  detectLocale,
  isLocale,
  LOCALE_NAMES,
  LOCALE_PACKS,
  localeFromSessionLanguage,
  matchLocalizedIntent,
  MESSAGE_CATALOG,
  parseLanguageChoice,
  SUPPORTED_LOCALES,
  t27,
  tr,
} from "./i18n";

describe("W27 locale set", () => {
  it("supports exactly en/fr/ha/yo/ig/sw/am", () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(["am", "en", "fr", "ha", "ig", "sw", "yo"]);
    expect(isLocale("sw")).toBe(true);
    expect(isLocale("am")).toBe(true);
    expect(isLocale("pcm")).toBe(false);
  });
  it("has full LocalePack entries for sw + am", () => {
    for (const loc of ["sw", "am"] as const) {
      expect(LOCALE_PACKS[loc].greeting.length).toBeGreaterThan(5);
      expect(LOCALE_PACKS[loc].menuLabels.shop.length).toBeGreaterThan(2);
      expect(LOCALE_PACKS[loc].consentPrompt.length).toBeGreaterThan(20);
      expect(tr(loc, "tracking")).toBe(LOCALE_PACKS[loc].tracking);
    }
  });
  it("maps session language names for the new locales", () => {
    expect(localeFromSessionLanguage("swahili")).toBe("sw");
    expect(localeFromSessionLanguage("amharic")).toBe("am");
    expect(localeFromSessionLanguage("english")).toBe("en");
  });
  it("detects Swahili and Amharic text", () => {
    expect(detectLocale("Habari, bei gani ya bidhaa hii? Nataka kununua tafadhali")).toBe("sw");
    expect(detectLocale("ሰላም ዋጋ ስንት ነው ግዛ እፈልጋለሁ")).toBe("am");
    expect(detectLocale("Sannu! Nawa kudin wannan?")).toBe("ha"); // regression
  });
});

describe("message catalog (t27)", () => {
  it("covers main-menu, catalog, order, discovery and payment keys in en", () => {
    const keys = [
      "mainMenuPrompt", "catalogHeader", "cartSummaryHeader", "checkoutPrompt",
      "orderPlaced", "discoveryAskLocation", "paymentPrompt", "paymentLinkReady",
      "paymentReceived",
    ] as const;
    for (const k of keys) expect(MESSAGE_CATALOG.en[k].length).toBeGreaterThan(3);
  });
  it("renders real translations for every core key in all locales", () => {
    const core = ["languageMenuPrompt", "catalogHeader", "cartEmpty", "checkoutPrompt", "paymentPrompt"] as const;
    for (const loc of SUPPORTED_LOCALES) {
      for (const k of core) {
        const v = MESSAGE_CATALOG[loc][k];
        expect(v, `${loc}.${k}`).toBeTruthy();
        if (loc !== "en") expect(v, `${loc}.${k} must differ from en`).not.toBe(MESSAGE_CATALOG.en[k]);
      }
    }
  });
  it("falls back to en for keys missing in a locale", () => {
    expect(t27("ig", "paymentPending")).toBe(MESSAGE_CATALOG.en.paymentPending);
    expect(t27("am", "paymentPending")).toBe(MESSAGE_CATALOG.en.paymentPending);
  });
  it("falls back to en for unknown/undefined locales", () => {
    expect(t27("zz", "cartEmpty")).toBe(MESSAGE_CATALOG.en.cartEmpty);
    expect(t27(null, "cartEmpty")).toBe(MESSAGE_CATALOG.en.cartEmpty);
  });
  it("interpolates {vars} and tenant overrides win", () => {
    expect(t27("en", "paymentPrompt", { total: "1,500", currency: "NGN" }))
      .toBe("💳 Total to pay: 1,500 NGN.");
    expect(t27("ha", "cartEmpty", {}, { cartEmpty: "CUSTOM" })).toBe("CUSTOM");
  });
});

describe("language picker", () => {
  it("renders a numbered menu with all 7 locales", () => {
    const menu = buildLanguageMenu("en");
    for (const loc of SUPPORTED_LOCALES) expect(menu).toContain(LOCALE_NAMES[loc]);
    expect(menu).toContain("7.");
  });
  it("parses index, code, name and alias choices", () => {
    expect(parseLanguageChoice("1")).toBe("en");
    expect(parseLanguageChoice("3")).toBe("ha");
    expect(parseLanguageChoice("7")).toBe("am");
    expect(parseLanguageChoice("yo")).toBe("yo");
    expect(parseLanguageChoice("Yorùbá")).toBe("yo");
    expect(parseLanguageChoice("kiswahili")).toBe("sw");
    expect(parseLanguageChoice("አማርኛ")).toBe("am");
    expect(parseLanguageChoice("nope")).toBeNull();
    expect(parseLanguageChoice("0")).toBeNull();
    expect(parseLanguageChoice("8")).toBeNull();
  });
});

describe("locale-aware NLU", () => {
  it("maps core intents across locales", () => {
    expect(matchLocalizedIntent("sayayya", "ha")).toBe("shop");
    expect(matchLocalizedIntent("rà", "yo")).toBe("shop");
    expect(matchLocalizedIntent("zụta", "ig")).toBe("shop");
    expect(matchLocalizedIntent("nunua", "sw")).toBe("shop");
    expect(matchLocalizedIntent("ግዛ", "am")).toBe("shop");
    expect(matchLocalizedIntent("tọpa", "yo")).toBe("track");
    expect(matchLocalizedIntent("fuatilia", "sw")).toBe("track");
    expect(matchLocalizedIntent("biya", "ha")).toBe("pay");
    expect(matchLocalizedIntent("kikapu", "sw")).toBe("checkout");
    expect(matchLocalizedIntent("kusa da ni", "ha")).toBe("discover");
    expect(matchLocalizedIntent("በአቅራቢያዬ", "am")).toBe("discover");
    expect(matchLocalizedIntent("harshe", "ha")).toBe("language");
  });
  it("falls back to the English keyword list inside any locale", () => {
    expect(matchLocalizedIntent("track", "sw")).toBe("track");
    expect(matchLocalizedIntent("menu", "am")).toBe("menu");
  });
  it("is diacritic- and case-insensitive, and returns null for unmapped text", () => {
    expect(matchLocalizedIntent("  LIPA ", "sw")).toBe("pay");
    expect(matchLocalizedIntent("random gibberish here", "ha")).toBeNull();
  });
});
