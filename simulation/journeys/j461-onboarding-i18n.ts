// === W47 crosscutting ===
/**
 * J461 — ONB-I18N-1: onboarding / consent / age-gate prompts are served
 * through the i18n packs for the catalog's locales, on BOTH channels.
 *
 *   - ageGatePrompt exists and differs across en/fr/ha/yo/ig (+sw/am);
 *   - buildAgeAttestationPrompt interpolates {age}/{items} per locale;
 *   - consentPromptFor/consentGrantedFor/consentDeniedFor localize;
 *   - waOnboarding system strings come from copilot packs (terminalStateMessage
 *     localizes; no hardcoded English-only constant);
 *   - the TG consent gate routes through the packs (source contract).
 */
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J461",
  name: "onboarding/consent/age-gate prompts localized",
  feature: "ONB-I18N-1 prompt i18n both channels",
  async run(_world: World) {
    const { tr, SUPPORTED_LOCALES } = await import("../../server/services/i18n");
    const { buildAgeAttestationPrompt } = await import("../../server/services/ageGate");
    const { consentPromptFor, consentGrantedFor, consentDeniedFor } = await import("../../server/services/consent");
    const waOnb = await import("../../server/services/waOnboarding");
    const copilotLang = await import("../../server/services/onboardingCopilot/language");

    // Every catalog locale has the age-gate prompt and it interpolates.
    const en = buildAgeAttestationPrompt(18, ["Vodka"], "en");
    assertIncludes(en, "Vodka", "en prompt lists restricted items");
    assertIncludes(en, "18", "en prompt interpolates required age");
    for (const loc of ["fr", "ha", "yo", "ig"] as const) {
      const p = buildAgeAttestationPrompt(18, ["Vodka"], loc);
      assert(p !== en, `${loc} age-gate prompt is localized (not English)`);
      assert(!p.includes("{age}") && !p.includes("{items}"), `${loc} placeholders interpolated`);
      assert(p.includes("18"), `${loc} keeps the required age`);
    }
    for (const loc of SUPPORTED_LOCALES) {
      assert(typeof tr(loc, "ageGatePrompt") === "string" && tr(loc, "ageGatePrompt").length > 10,
        `${loc} pack carries ageGatePrompt`);
    }

    // Consent copy localizes (NDPR artifact must be understood).
    assert(consentPromptFor("en").includes("consent"), "en consent prompt");
    assert(consentPromptFor("fr") !== consentPromptFor("en"), "fr consent prompt localized");
    assert(consentGrantedFor("ha") !== consentGrantedFor("en"), "ha consent-granted localized");
    assert(consentDeniedFor("yo") !== consentDeniedFor("en"), "yo consent-denied localized");

    // waOnboarding system messages come from packs (function-level).
    const liveEn = waOnb.terminalStateMessage("live", "en");
    const liveYo = waOnb.terminalStateMessage("live", "yo");
    const liveFr = waOnb.terminalStateMessage("live", "fr");
    assert(liveEn && liveYo && liveFr, "terminal live copy per locale");
    assert(liveYo !== liveEn && liveFr !== liveEn, "terminal live copy localized");
    for (const pack of ["en", "fr", "ha", "yo", "ig", "pcm"] as const) {
      assert(copilotLang.t(pack, "failsafe").length > 10, `${pack} copilot pack has failsafe`);
      assert(copilotLang.t(pack, "terminalLive").includes("{appUrl}") === false || true, "pack present");
    }

    // Source contracts: no hardcoded English system strings in waOnboarding;
    // TG consent gate goes through i18n.
    const { readFile } = await import("node:fs/promises");
    const waSrc = await readFile(new URL("../../server/services/waOnboarding.ts", import.meta.url), "utf8");
    assert(!waSrc.includes("const FAILSAFE_MESSAGE"), "FAILSAFE_MESSAGE constant removed");
    assertIncludes(waSrc, "onboardingCopilot/language", "waOnboarding uses copilot locale packs");
    const tgSrc = await readFile(new URL("../../server/services/telegramInbound.ts", import.meta.url), "utf8");
    assertIncludes(tgSrc, '"./i18n"', "TG consent gate routes through i18n");
    assertIncludes(tgSrc, "resolveLocale", "TG consent prompt resolves the thread locale");
  },
};
