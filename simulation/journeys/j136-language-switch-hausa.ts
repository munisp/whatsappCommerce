/**
 * J136 — W27 multi-language framework: language switch → menus in Hausa.
 *
 * End-to-end over the WhatsApp inbound pipeline:
 *   1. Customer asks for the language menu ("language") → numbered picker
 *      with all 7 supported locales.
 *   2. Choosing "3" (Hausa) confirms in Hausa and re-renders the main menu
 *      with Hausa chrome (greeting + use-case labels from the ha pack).
 *   3. The sticky locale persists: the next "menu" render stays Hausa.
 *   4. Locale-aware NLU: the Hausa keyword "sayayya" maps to the shop
 *      intent and enters the shop use case; unit seam asserts the full
 *      keyword map (menu/track/pay/discover across locales, en fallback).
 */
import { assert, assertIncludes, bodyText } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J136",
  name: "language switch → menus in Hausa",
  feature: "language picker, sticky locale, localized menu chrome, localized intent keywords",
  async run(world) {
    const i18n = await import("../../server/services/i18n");
    const phone = world.newPhone("ha");
    await world.grantConsent(phone);

    // ── 0. Unit seam: localized intent map ───────────────────────────────
    assert(i18n.matchLocalizedIntent("sayayya", "ha") === "shop", "ha 'sayayya' → shop");
    assert(i18n.matchLocalizedIntent("tọpa", "yo") === "track", "yo 'tọpa' → track");
    assert(i18n.matchLocalizedIntent("lipa", "sw") === "pay", "sw 'lipa' → pay");
    assert(i18n.matchLocalizedIntent("ክፍያ", "am") === "pay", "am 'ክፍያ' → pay");
    assert(i18n.matchLocalizedIntent("kusa da ni", "ha") === "discover", "ha 'kusa da ni' → discover");
    assert(i18n.matchLocalizedIntent("produits", "fr") === "shop", "fr 'produits' → shop");
    assert(i18n.matchLocalizedIntent("TRACK", "ig") === "track", "en fallback inside non-en locale");
    assert(i18n.matchLocalizedIntent("xyzzy nothing", "ha") === null, "unmapped text falls through");
    assert(i18n.parseLanguageChoice("3") === "ha", "menu index 3 → Hausa");
    assert(i18n.parseLanguageChoice("kiswahili") === "sw", "alias 'kiswahili' → sw");
    assert(i18n.parseLanguageChoice("maybe") === null, "invalid choice → null");

    // ── 1. Open the language picker ──────────────────────────────────────
    await world.text(phone, "language");
    const picker = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(picker, "Hausa", "picker lists Hausa");
    assertIncludes(picker, "Kiswahili", "picker lists Kiswahili");
    assertIncludes(picker, "አማርኛ", "picker lists Amharic");

    // ── 2. Choose Hausa (index 3) → confirmation + menu in Hausa ────────
    await world.text(phone, "3");
    const after = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(after, "Hausa", "confirmation names the chosen language");
    assertIncludes(after, "Sannu da zuwa", "menu greeting rendered from the Hausa pack");
    assertIncludes(after, "Sayayya / aika oda", "shop label rendered in Hausa");

    // ── 3. Sticky locale: next menu render stays Hausa ───────────────────
    await world.text(phone, "menu");
    const interactive = world.outbound.lastOfType("interactive", phone);
    assert(interactive, "menu re-rendered as interactive payload");
    const serialized = JSON.stringify(interactive.body?.interactive);
    assertIncludes(serialized, "Sayayya / aika oda", "sticky Hausa labels on the interactive menu");
    assertIncludes(serialized, "Bibiyar odana", "sticky Hausa track label");

    // ── 4. Hausa keyword drives the shop intent end-to-end ───────────────
    world.llm.when("sayayya", {
      reply: "Ga kayayyakinmu — me kake so?",
      intent: "browse",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "sayayya");
    const shopReply = bodyText(world.outbound.lastOfType("text", phone));
    assert(shopReply.length > 0, "Hausa 'sayayya' produced a reply (shop use case / NLP handoff)");
  },
};
