/**
 * J74 — Language detection edge cases (W15 F5).
 *
 * Resolution policy under adversarial text, asserted both at the unit seam
 * (detectMessageLanguage / parseExplicitLanguageChoice / resolveTurnLanguage)
 * and end-to-end against live onboarding sessions:
 *   1. English "I don't …" does NOT flip the thread to pidgin — regression
 *      for the stopword bug C1 fixed (pcm's "i don" no longer matches the
 *      apostrophe'd "I don't").
 *   2. Low-confidence messages keep the sticky thread language.
 *   3. Mixed-language thread follows the LATEST high-confidence message
 *      (yo → ha switches; detection switches, low confidence sticks).
 *   4. Unknown / empty text → English default.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { onboardingSessionByPhone } from "./helpers";

export const journey: Journey = {
  id: "J74",
  name: "language detection edge cases",
  feature: "sticky low-confidence + latest-message wins + C1 stopword regression",
  async run(world) {
    const lang = await import("../../server/services/onboardingCopilot/language");

    // ── 0. Unit seam: the C1 stopword regression ───────────────────────────
    const dont = lang.detectMessageLanguage("I don't want that one, thanks");
    assert(
      dont.language === "en" && dont.confidence === "low",
      `'I don't' must NOT score as pidgin (got ${dont.language}/${dont.score})`,
    );
    assert(
      lang.detectMessageLanguage("you don't say").language === "en",
      "'you don't' stays English",
    );
    assert(
      lang.detectMessageLanguage("I don finish my registration o").language === "pcm",
      "genuine pidgin 'I don …' still detects pcm",
    );
    assert(lang.parseExplicitLanguageChoice("speak pidgin") === "pcm", "explicit 'speak pidgin'");
    assert(lang.parseExplicitLanguageChoice("ka sọ̀rọ̀ ní yorùbá") === "yo", "trailing-alias 'ní yorùbá'");
    assert(lang.parseExplicitLanguageChoice("what do you sell?") === null, "no false explicit parse");
    assert(
      lang.detectMessageLanguage("").confidence === "low" &&
        lang.detectMessageLanguage("hmm ok").confidence === "low",
      "empty/unknown text is low-confidence",
    );

    // resolveTurnLanguage: explicit > high-confidence > sticky > en.
    const carrier = { intake: {} as Record<string, unknown> };
    let r = lang.resolveTurnLanguage(carrier, "hello there");
    assert(r.language === "en" && !r.switched, "first low-confidence message → en default");
    r = lang.resolveTurnLanguage(carrier, "Bawo ni, ṣe e dára? Mo fẹ́ bẹ̀rẹ̀ iṣòwò mi");
    assert(r.language === "yo" && r.switched && !r.explicit, "high-confidence yo switches the thread");
    r = lang.resolveTurnLanguage(carrier, "ok thank you");
    assert(r.language === "yo" && !r.switched, "low-confidence keeps sticky yo");
    r = lang.resolveTurnLanguage(carrier, "speak pidgin");
    assert(r.language === "pcm" && r.explicit, "explicit choice beats sticky detection");
    r = lang.resolveTurnLanguage(carrier, "Sannu! Ina son in bude shago, don Allah");
    assert(r.language === "ha" && r.switched, "high-confidence ha follows the latest message even after an earlier explicit choice");

    // ── 1. e2e: English "I don't" thread never leaves English ─────────────
    const phoneA = world.newPhone("a");
    await world.onboardingText(phoneA, "hello", { profileName: "A" }); // session + greeting
    await world.onboardingText(phoneA, "I don't know where to start honestly");
    const a1 = await onboardingSessionByPhone(phoneA);
    assert(a1, "session A active");
    assert(
      (a1!.intake.language ?? "en") === "en",
      `C1 regression: "I don't" did not flip the thread to pidgin (got ${a1!.intake.language})`,
    );

    // ── 2. e2e: sticky language survives low-confidence follow-ups ────────
    const phoneB = world.newPhone("b");
    await world.onboardingText(phoneB, "hi", { profileName: "B" });
    await world.onboardingText(phoneB, "Ẹ káàbọ̀, mo fẹ́ ṣe ìforúkọsílẹ̀ iṣòwò mi");
    const b1 = await onboardingSessionByPhone(phoneB);
    assert(b1?.intake.language === "yo", `thread switched to yo (got ${b1?.intake.language})`);
    await world.onboardingText(phoneB, "okay then");
    const b2 = await onboardingSessionByPhone(phoneB);
    assert(b2?.intake.language === "yo", "low-confidence 'okay then' keeps sticky yo");

    // ── 3. e2e: mixed-language thread follows the latest message ──────────
    await world.onboardingText(phoneB, "Sannu! Ina son in gaya maka kasuwancina, nawa kudin rajista?");
    const b3 = await onboardingSessionByPhone(phoneB);
    assert(b3?.intake.language === "ha", `latest high-confidence Hausa message wins (got ${b3?.intake.language})`);
    await world.onboardingText(phoneB, "fine");
    const b4 = await onboardingSessionByPhone(phoneB);
    assert(b4?.intake.language === "ha", "sticky ha after low-confidence English");
  },
};
