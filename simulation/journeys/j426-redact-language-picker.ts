// === W46 platform-p2 ===
/**
 * J426 — PLT-25 (central redact() logger + waLocation/worst PII sites) +
 * MSG-23 (low-confidence locale detection → language picker on BOTH
 * channels, no silent sticky English).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J426",
  name: "PII redact logger + low-confidence locale → language picker",
  feature: "platform-p2: PLT-25 + MSG-23",
  async run() {
    // ── PLT-25 functional: redact() ──────────────────────────────────────
    const lr = await import("../../server/services/logRedact");
    const phone = lr.redactString("send to +2348012345678 now");
    assert(!phone.includes("2348012345678"), "phone number masked");
    assert(phone.includes("**78"), "masked phone keeps last-2 only");
    const email = lr.redactString("user jane.doe@example.com wrote");
    assert(!email.includes("jane.doe@"), "email local-part masked");
    const deep = lr.redact({ toPhone: "+2348012345678", body: "hello secret body", note: "ok" }) as any;
    assert(!JSON.stringify(deep).includes("2348012345678"), "sensitive keys redacted in objects");
    assert(deep.note === "ok", "non-sensitive fields preserved");
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    assert(typeof lr.redact(cyc) === "object", "cycle-safe");

    // ── PLT-25 source: waLocation + worst sites routed through redaction ──
    const waLoc = await readFile(`${repoRoot}/server/services/waLocation.ts`, "utf8");
    assert(!waLoc.includes("console.info(`[waLocation] simulated location request → ${toPhone}"),
      "waLocation no longer logs raw toPhone");
    assertIncludes(waLoc, 'from "./logRedact"', "waLocation uses the central helper");
    for (const f of ["waOnboarding.ts", "banCircuitBreaker.ts", "waSender.ts"]) {
      const src = await readFile(`${repoRoot}/server/services/${f}`, "utf8");
      assertIncludes(src, 'from "./logRedact"', `${f} imports redactString`);
    }
    const helper = await readFile(`${repoRoot}/server/services/logRedact.ts`, "utf8");
    assertIncludes(helper, "LINT NOTE", "lint note present pending an eslint rule");

    // ── MSG-23 functional: confidence-aware detection ────────────────────
    const i18n = await import("../../server/services/i18n");
    // Confident non-English stays detectable (unchanged contract).
    const confident = i18n.detectLocaleDetailed("Sannu! Nawa ne kudin wannan? Ina son sayayya, don Allah");
    assert(confident.locale === "ha" && confident.lowConfidence === false, "confident Hausa detection");
    assert(i18n.detectLocale("Sannu! Nawa ne kudin wannan? Ina son sayayya, don Allah") === "ha", "detectLocale unchanged");
    // Weak single-stopword signal → low confidence (picker, not sticky).
    const weak = i18n.detectLocaleDetailed("kedu");
    assert(weak.lowConfidence === true, "weak signal flagged low-confidence");
    // Unsupported locale → low confidence (was: silent sticky English).
    const unsupported = i18n.detectLocaleDetailed("obrigado pelo vosso apoio");
    assert(unsupported.lowConfidence === true, "unsupported locale flagged low-confidence");
    // English / digits / menu picks → NEVER low-confidence.
    assert(i18n.detectLocaleDetailed("hello, I want to buy rice").lowConfidence === false, "English unaffected");
    assert(i18n.detectLocaleDetailed("2").lowConfidence === false, "menu digit unaffected");
    assert(i18n.detectLocaleDetailed("menu").lowConfidence === false, "menu keyword unaffected");
    assert(i18n.looksLikeEnglish("1") && i18n.looksLikeEnglish("ok"), "non-language-bearing text is safe");

    // Resolution: low-confidence is NOT made sticky.
    i18n.__clearMemoryLocales();
    const res = await i18n.resolveLocaleDetailed({ tenantId: "jt426", phone: "+2340000000001", text: "obrigado pelo vosso apoio" });
    assert(res.lowConfidence === true, "resolution surfaces lowConfidence");
    const sticky = await i18n.getStickyLocale("jt426", "+2340000000001").catch(() => null);
    assert(sticky === null, "low-confidence detection NOT sticky");

    // ── MSG-23 channel parity: BOTH channels wire the picker ─────────────
    const useCases = await readFile(`${repoRoot}/server/services/useCases.ts`, "utf8");
    assertIncludes(useCases, "localeResolution.lowConfidence", "WA picker gate");
    assertIncludes(useCases, "languagePickerOffered: true", "WA offers picker once per session");
    const tg = await readFile(`${repoRoot}/server/services/telegramInbound.ts`, "utf8");
    assertIncludes(tg, "telegramLanguagePickerGate", "Telegram picker gate");
    assertIncludes(tg, "detectLocaleDetailed", "Telegram uses confidence detection");
    assertIncludes(tg, "buildLanguageMenu", "Telegram sends the language menu");
    assertIncludes(tg, "setStickyLocale", "Telegram choice becomes sticky");
  },
};
