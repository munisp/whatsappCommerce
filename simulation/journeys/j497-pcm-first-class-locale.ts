// === W49 I18N-PCM ===
/**
 * J497 — Nigerian Pidgin (pcm) promoted to a first-class locale.
 *
 *   1. Detection: "Abeg how far, wetin dey for shop?" detects pcm with
 *      confidence (score >= LOCALE_CONFIDENT_THRESHOLD) and sticks.
 *   2. Apostrophe regression: "I don't want it" stays en (the pcm "i don"
 *      phrase stopword must not match inside "don't").
 *   3. Picker: 8 locales listed incl. "Naija (Pidgin)"; pidgin/naija/
 *      "naija pidgin"/"broken english" aliases parse; index 8 = pcm;
 *      "pidgin" alone opens the language menu.
 *   4. Catalog + LocalePack: all 27 MessageKeys and all LocalePack keys
 *      render for pcm with {vars} interpolated; BUREAU_CONSENT_TEXT.pcm.
 *   5. Tenant override wins for pcm (durable tenant_i18n_overrides row).
 *   6. TG consent: pcm consentPrompt carries the literal "WhatsApp" so the
 *      WhatsApp→Telegram swap lands (I18N-8).
 *   7. Session-language bridge: nlp "pidgin" session language → pcm chrome
 *      via localeFromSessionLanguage (I18N-4); USSD legacy menus carry
 *      pcm/ha/yo/ig strings (I18N-9, source contract).
 */
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J497",
  name: "pcm (Nigerian Pidgin) first-class locale",
  feature: "W49 pcm locale: detection, picker, catalog, overrides, TG consent, session bridge",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const i18n = await import("../../server/services/i18n");

    // ── 1. Confident pcm detection + sticky write ────────────────────────
    const det = i18n.detectLocaleDetailed("Abeg how far, wetin dey for shop?");
    assert(det.locale === "pcm", `pidgin greeting detects pcm (got ${det.locale}, score ${det.score})`);
    assert(!det.lowConfidence, "pcm detection is confident (no picker)");
    assert(det.score >= i18n.LOCALE_CONFIDENT_THRESHOLD, `pcm score clears threshold (${det.score})`);
    const phone = world.newPhone("497");
    const resolved = await i18n.resolveLocaleDetailed({ tenantId: TENANT_ID, phone, text: "Abeg how far, wetin dey for shop?" });
    assert(resolved.locale === "pcm" && resolved.source === "detected", "resolveLocaleDetailed detects pcm");
    const sticky = await i18n.getStickyLocale(TENANT_ID, phone);
    assert(sticky === "pcm", `confident pcm detection is sticky (got ${sticky})`);
    // Sticky pcm now wins over later English text (the bridge exists).
    const again = await i18n.resolveLocaleDetailed({ tenantId: TENANT_ID, phone, text: "thank you" });
    assert(again.locale === "pcm" && again.source === "sticky", "sticky pcm overrides later English text");

    // ── 2. Apostrophe regression: English contractions stay en ───────────
    assert(i18n.detectLocale("I don't want it") === "en", "'I don't want it' stays en (apostrophe boundary)");
    assert(i18n.detectLocale("we don't deliver on Sundays") === "en", "contractions never misdetect as pcm/ha");
    assert(i18n.detectLocale("Abeg wetin dey happen") === "pcm", "pidgin markers still detect pcm");

    // ── 3. Picker: 8 locales + pidgin aliases ────────────────────────────
    const menu = i18n.buildLanguageMenu("en");
    assert(i18n.SUPPORTED_LOCALES.length === 8, "8 supported locales");
    assertIncludes(menu, "8.", "picker lists 8 entries");
    assertIncludes(menu, "Naija (Pidgin)", "picker names pcm");
    assert(i18n.LOCALE_NAMES.pcm === "Naija (Pidgin)", "LOCALE_NAMES.pcm");
    for (const alias of ["pidgin", "naija", "naija pidgin", "broken english", "pcm"]) {
      assert(i18n.parseLanguageChoice(alias) === "pcm", `alias "${alias}" parses to pcm`);
    }
    assert(i18n.parseLanguageChoice("8") === "pcm", "index 8 parses to pcm");
    assert(i18n.isLanguageMenuRequest("pidgin"), "'pidgin' alone opens the language menu");

    // ── 4. pcm catalog + LocalePack render with vars ─────────────────────
    const MESSAGE_KEYS = [
      "languageMenuPrompt", "languageSetConfirm", "languageMenuHint",
      "mainMenuPrompt", "backToMenu", "invalidSelection",
      "catalogHeader", "catalogEmpty", "catalogItemOutOfStock", "catalogItemAdded",
      "catalogMoreHint", "cartSummaryHeader", "cartEmpty", "checkoutPrompt",
      "orderConfirmPrompt", "orderPlaced", "orderCancelled", "askDeliveryAddress",
      "discoveryAskLocation", "discoveryEmpty", "discoveryHeader",
      "paymentPrompt", "paymentLinkReady", "paymentReceived", "paymentFailed",
      "paymentPending",
    ] as const;
    for (const k of MESSAGE_KEYS) {
      const v = i18n.MESSAGE_CATALOG.pcm[k];
      assert(typeof v === "string" && v.length > 3, `pcm catalog has ${k}`);
    }
    assert(MESSAGE_KEYS.length === 26, "all 26 MessageKeys enumerated (full MessageKey union)");
    const pay = i18n.t27("pcm", "paymentPrompt", { total: "2,500", currency: "NGN" });
    assertIncludes(pay, "2,500", "pcm paymentPrompt interpolates {total}");
    assertIncludes(pay, "NGN", "pcm paymentPrompt interpolates {currency}");
    assert(pay !== i18n.t27("en", "paymentPrompt", { total: "2,500", currency: "NGN" }), "pcm paymentPrompt differs from en");
    const placed = i18n.t27("pcm", "orderPlaced", { orderNumber: "B7", total: "500", currency: "NGN" });
    assertIncludes(placed, "B7", "pcm orderPlaced interpolates {orderNumber}");
    const PACK_KEYS = [
      "greeting", "consentPrompt", "consentGranted", "consentDenied",
      "cartRecovery", "shortageNote", "tracking", "voiceNotEnabled",
      "reorderNoPriorOrder", "disputeConfirm", "orderingSuspended",
      "orderingUnavailable", "paidViaCredit", "imageProcessingFailed",
      "ageGatePrompt",
    ] as const;
    for (const k of PACK_KEYS) {
      const v = i18n.tr("pcm", k);
      assert(typeof v === "string" && v.length > 5, `pcm pack has ${k}`);
    }
    for (const lbl of ["shop", "track", "support", "booking", "handoff", "procurement"] as const) {
      assert(i18n.LOCALE_PACKS.pcm.menuLabels[lbl].length > 2, `pcm menuLabels.${lbl}`);
    }
    const greet = i18n.interpolate(i18n.LOCALE_PACKS.pcm.greeting, { businessName: "Ada Stores" });
    assertIncludes(greet, "Ada Stores", "pcm greeting interpolates {businessName}");
    const suspended = i18n.interpolate(i18n.LOCALE_PACKS.pcm.orderingSuspended, { reason: ": credit hold", outstanding: " ₦5,000" });
    assert(!suspended.includes("{reason}") && suspended.includes("₦5,000"), "pcm orderingSuspended interpolates");
    assertIncludes(i18n.BUREAU_CONSENT_TEXT.pcm, "credit", "pcm bureau consent text present (NDPR)");
    assert(i18n.BUREAU_CONSENT_TEXT.pcm !== i18n.BUREAU_CONSENT_TEXT.en, "pcm bureau consent is localized");

    // ── 5. Tenant override wins for pcm ──────────────────────────────────
    const admin = await adminCaller();
    const tenantId = (await admin.onboarding.start({ name: "J497 Pidgin Shop" })).tenantId;
    const caller = await tenantCaller(tenantId, { userId: 4971 });
    await caller.i18n.setOverride({
      locale: "pcm", key: "cartEmpty", text: "Your cart empty pass my pocket (custom).",
    });
    const rows = await world.db.select().from(schema.tenantI18nOverrides);
    const mine = rows.filter((r) => r.tenantId === tenantId && r.locale === "pcm");
    assert(mine.length === 1 && mine[0].key === "cartEmpty", "pcm override row persisted");
    const overridden = i18n.t27("pcm", "cartEmpty", {}, { cartEmpty: mine[0].text });
    assert(overridden === "Your cart empty pass my pocket (custom).", "tenant override beats the pcm catalog");
    await caller.i18n.removeOverride({ locale: "pcm", key: "cartEmpty" });
    const after = await world.db.select().from(schema.tenantI18nOverrides);
    assert(after.filter((r) => r.tenantId === tenantId).length === 0, "pcm override removed");
    assert(i18n.t27("pcm", "cartEmpty") === i18n.MESSAGE_CATALOG.pcm.cartEmpty, "pcm catalog resumes after removal");

    // ── 6. TG consent: pcm prompt carries "WhatsApp" for the swap ────────
    const prompt = i18n.tr("pcm", "consentPrompt");
    assertIncludes(prompt, "WhatsApp", "pcm consentPrompt contains literal WhatsApp (TG swap target)");
    const tg = prompt.replace(/WhatsApp/g, "Telegram");
    assertIncludes(tg, "Telegram", "WhatsApp→Telegram swap lands on pcm prompt");
    assert(!tg.includes("WhatsApp"), "no WhatsApp left after swap");
    const { readFile } = await import("node:fs/promises");
    const tgSrc = await readFile(new URL("../../server/services/telegramInbound.ts", import.meta.url), "utf8");
    assertIncludes(tgSrc, '.replace(/WhatsApp/g, "Telegram")', "TG channel performs the consent swap");

    // ── 7. Session-language bridge + USSD menus ──────────────────────────
    for (const name of ["pidgin", "pcm", "naija", "broken"]) {
      assert(i18n.localeFromSessionLanguage(name) === "pcm", `session language "${name}" → pcm`);
    }
    const chrome = i18n.tr(i18n.localeFromSessionLanguage("pidgin"), "greeting");
    assert(chrome === i18n.LOCALE_PACKS.pcm.greeting, "pidgin session renders pcm chrome");
    const nlpSrc = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    for (const snippet of [
      'pcm: "Products:\\n1. See all', // browse pcm
      "Koma babban menu", // browse ha
      "Padà sí menu gbangba", // browse yo
      "Laghachi na menu isi", // browse ig
      "Shigar da adireshin isarwa", // checkout_address ha
      "Tinye adreesị nnyefe", // checkout_address ig
      "localeFromSessionLanguage(lang)", // session-name → locale-code bridge
    ]) {
      assertIncludes(nlpSrc, snippet, `nlp USSD menu coverage: ${snippet}`);
    }
  },
};
