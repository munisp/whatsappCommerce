/**
 * === W53 RESIDUALS ===
 * J537 — USSD greeting locale parity: the USSD_MENUS greeting renders in
 * French, Swahili, Amharic (added W53) and Nigerian Pidgin pcm (W49), with
 * English as the control. Language stickiness is exercised through the REAL
 * nlp.processMessage ussdMode path (the same path the /ussd gateway's NLP
 * fallback drives), with the session locale pinned directly — fr/sw/am have
 * no text-detection hints by design, so the DB pin is the deterministic
 * seam a real language-picker selection would produce.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { eq } from "drizzle-orm";

const CASES: Array<{ sessionLanguage: string; expect: string }> = [
  { sessionLanguage: "english", expect: "Welcome! Reply:" },
  { sessionLanguage: "french", expect: "Bienvenue ! Répondez" },
  { sessionLanguage: "swahili", expect: "Karibu! Jibu:" },
  { sessionLanguage: "amharic", expect: "እንኳን ደህና መጡ" },
  // pidgin session language resolves to the pidgin key (English-like
  // greeting, distinct option labels vs the en control — "See products").
  { sessionLanguage: "pidgin", expect: "Welcome! Reply:\n1. See products" },
  // pcm locale key renders the W49 pcm string.
  { sessionLanguage: "pcm", expect: "How far! Reply:" },
];

export const journey: Journey = {
  id: "J537",
  name: "USSD greeting renders fr/sw/am/pcm (+en control)",
  feature: "W53 residuals: USSD_MENUS greeting locale parity",
  async run(world: World) {
    const { appRouter } = await import("../../server/routers");
    const { nlpSessions } = await import("../../drizzle/schema");
    const caller = appRouter.createCaller({ user: null } as any);

    for (const c of CASES) {
      const phone = world.newPhone("j537");
      // First turn creates the session (ussdMode → numbered menu in English).
      const first = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone, message: "hi", ussdMode: true,
      });
      assert(first.intent === "ussd_menu", `ussd mode returns the menu (got intent ${first.intent})`);
      // Pin the session locale (deterministic stand-in for a picker choice).
      await world.db
        .update(nlpSessions)
        .set({ language: c.sessionLanguage })
        .where(eq(nlpSessions.id, first.sessionId));
      const r = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone, message: "hi", ussdMode: true,
      });
      assert(r.intent === "ussd_menu", `${c.sessionLanguage}: still the ussd menu path`);
      assert(
        String(r.reply).startsWith(c.expect),
        `${c.sessionLanguage}: greeting must start with "${c.expect}", got "${String(r.reply).slice(0, 60)}"`,
      );
      // Numbered options survive in every locale.
      assert(/1\. .+\n2\. .+\n3\. .+\n4\. /s.test(String(r.reply)), `${c.sessionLanguage}: 4 numbered options render`);
    }
  },
};
