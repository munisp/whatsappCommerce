/**
 * J73 — Multilingual onboarding e2e (W15 F5).
 *
 * A prospect onboards end-to-end in YORUBA on the platform onboarding number:
 * first contact (en greeting — no thread language known yet) → a high-
 * confidence Yoruba intake message switches the thread (detection ≥1.5 via
 * the ṣ/ẹ diacritic hints) and the proposal intro is rendered from the yo
 * text pack → mid-thread explicit switch to Pidgin ("speak pidgin") gets the
 * localized pcm switch confirmation → approvals land in pcm → the repair
 * question (missing WhatsApp creds) is pcm → the English credential paste
 * stays sticky-pcm (low-confidence detection never overrides the thread) →
 * go-live + live message in pcm.
 *
 * Regression: a second thread completed in ENGLISH is byte-identical to the
 * wave-9 strings (en pack is the source of truth).
 */
import {
  assert,
  assertIncludes,
  bodyText,
  type World,
} from "../world";
import type { Journey } from "../runner";
import { registerGraphObject, clearGraphObject } from "../metaMock";
import {
  approvePendingViaButtons,
  onboardingSessionById,
  onboardingSessionByPhone,
} from "./helpers";

const J73_PHONE_NUMBER_ID = "109000777000073";
const J73_WA_TOKEN = "EAAj73prospecttoken0123456789";

export const journey: Journey = {
  id: "J73",
  name: "multilingual onboarding e2e",
  feature: "yo thread → explicit pcm switch → live; en byte-compat",
  async run(world) {
    const lang = await import("../../server/services/onboardingCopilot/language");
    const phoneYo = world.newPhone("onb");
    const phoneEn = world.newPhone("onb");

    process.env.WAC_WHATSAPP_TOKEN = "sim-wa-access-token";
    process.env.WAC_WHATSAPP_PHONE_ID = J73_PHONE_NUMBER_ID;
    try {
      // ── 1. First contact → session + (English) greeting ──────────────────
      await world.onboardingText(phoneYo, "Ẹ káàbọ̀ o", { profileName: "Funke" });
      const greeting = bodyText(world.outbound.lastOfType("text", phoneYo));
      assert(
        greeting === lang.COPILOT_TEXT_PACKS.en.greeting,
        "first-contact greeting is the byte-identical wave-9 English greeting",
      );
      const s1 = await onboardingSessionByPhone(phoneYo);
      assert(s1 && s1.state === "intake", `session in intake (got ${s1?.state})`);
      assert(
        lang.sessionLanguage(s1!) === "en",
        "no thread language known yet → en default",
      );

      // ── 2. Yoruba intake → detection switches the thread to yo ──────────
      await world.onboardingText(
        phoneYo,
        "Orúkọ iṣòwò mi ni Adire Aláàfin, mo ń ta àṣọ adire ní Ìbàdàn, " +
          "mo ń fi ọjà ráńṣẹ́ fún àwọn ónìbàárà, a sì ń gba bank transfer",
      );
      const s2 = await onboardingSessionByPhone(phoneYo);
      assert(s2, "session active after Yoruba intake");
      assert(
        s2!.intake.language === "yo",
        `high-confidence detection switched the thread to yo (got ${s2!.intake.language})`,
      );
      assert(
        s2!.intake.facts.businessName === "Adire Aláàfin",
        `business name extracted from Yoruba text (got ${s2!.intake.facts.businessName})`,
      );
      assert(s2!.intake.facts.city === "Ìbàdàn", `city extracted (got ${s2!.intake.facts.city})`);
      assert(s2!.state === "approving", `proposals awaiting approval (got ${s2!.state})`);
      const intro = bodyText(world.outbound.findByBody("ètò tí mo dámọ̀ọ́nìí", phoneYo).pop());
      assertIncludes(intro, "Adire Aláàfin", "proposal intro rendered from the yo pack");
      const expectedYoIntro = lang.t("yo", "proposalIntro", { businessName: "Adire Aláàfin" });
      assert(
        world.outbound.toPhone(phoneYo).some((c) => bodyText(c) === expectedYoIntro),
        "yo proposal intro is exactly the yo text-pack rendering",
      );

      // ── 3. Explicit mid-thread switch to Pidgin ──────────────────────────
      await world.onboardingText(phoneYo, "speak pidgin");
      const s3 = await onboardingSessionByPhone(phoneYo);
      assert(s3?.intake.language === "pcm", `explicit choice wins (got ${s3?.intake.language})`);
      const switchReply = bodyText(world.outbound.lastOfType("text", phoneYo));
      assert(
        switchReply === lang.t("pcm", "languageSwitched", { language: lang.LANGUAGE_NAMES.pcm }),
        `localized pcm switch confirmation (got ${switchReply.slice(0, 120)})`,
      );
      assertIncludes(switchReply, "No wahala", "pcm switch confirmation copy");

      // ── 4. Approve all proposal cards — decisions land in pcm ────────────
      await approvePendingViaButtons(world, phoneYo, ["waMenu", "useCases", "branding", "integrations"]);
      const decided = world.outbound.findByBody("You don approve", phoneYo);
      assert(decided.length > 0, "approval confirmations rendered from the pcm pack");
      const s4 = await onboardingSessionByPhone(phoneYo);
      assert(s4 && typeof s4.tenantId === "string" && s4.tenantId, "tenant provisioned on first apply");
      assert(s4!.state === "configuring", `validation failed → repair loop (got ${s4!.state})`);
      assert(s4!.intake.language === "pcm", "thread language persisted on the session intake jsonb");

      // ── 5. Repair question in pcm; English credential paste stays sticky ─
      const repairQ = bodyText(world.outbound.lastOfType("text", phoneYo));
      assertIncludes(repairQ, "I no fit reach your WhatsApp phone number", "pcm repair question");
      registerGraphObject(J73_PHONE_NUMBER_ID);
      await world.onboardingText(phoneYo, `phone number id is ${J73_PHONE_NUMBER_ID} token is ${J73_WA_TOKEN}`);
      const s5 = await onboardingSessionByPhone(phoneYo);
      assert(s5, "session active after credential paste");
      assert(
        s5!.intake.language === "pcm",
        "English credential paste is low-confidence → thread stays pcm (sticky)",
      );
      assert(s5!.state === "validating", `validation passed → awaiting go-live (got ${s5!.state})`);
      assert(
        world.outbound.findByBody("All the validation checks don pass", phoneYo).length > 0,
        "go-live prompt rendered from the pcm pack",
      );

      // ── 6. Approve go-live → live message in pcm ─────────────────────────
      const goLive = s5!.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
      assert(goLive, "goLive proposal pending");
      await world.onboardingButtonReply(phoneYo, `onb_approve:${goLive!.id}`, "Approve");
      const s6 = await onboardingSessionById(s5!.id);
      assert(s6?.state === "live", `session live (got ${s6?.state})`);
      assert(
        world.outbound.findByBody("You don LIVE!", phoneYo).length > 0,
        "live confirmation rendered from the pcm pack",
      );

      // ── 7. English regression thread — byte-identical wave-9 behaviour ───
      await world.onboardingText(phoneEn, "hello", { profileName: "Kemi" });
      const enGreeting = bodyText(world.outbound.lastOfType("text", phoneEn));
      assert(enGreeting === lang.COPILOT_TEXT_PACKS.en.greeting, "en greeting byte-identical");
      await world.onboardingText(
        phoneEn,
        "I run Kemi's Kitchen in Lagos, we sell food bowls, delivery within Lagos, bank transfer",
      );
      const sEn = await onboardingSessionByPhone(phoneEn);
      assert(sEn, "en session active");
      assert(sEn!.intake.language === "en" || sEn!.intake.language === undefined,
        `en thread never leaves English (got ${sEn!.intake.language})`);
      assert(sEn!.intake.facts.businessName === "Kemi's Kitchen", "en facts extracted");
      const expectedEnIntro = lang.t("en", "proposalIntro", { businessName: "Kemi's Kitchen" });
      assert(
        world.outbound.toPhone(phoneEn).some((c) => bodyText(c) === expectedEnIntro),
        "en proposal intro byte-identical to the wave-9 string",
      );
    } finally {
      delete process.env.WAC_WHATSAPP_TOKEN;
      delete process.env.WAC_WHATSAPP_PHONE_ID;
      clearGraphObject(J73_PHONE_NUMBER_ID);
    }
  },
};
