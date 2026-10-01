// === W47 buyer (Coder B) ===
/**
 * J446 — ONB-B-12 / QA-064: once the buyer locks a locale via the language picker (sticky locale), it must take
 * effect on the buyer's VERY NEXT message, not just sit recorded in the sticky store while every reply keeps
 * coming back in English.
 *
 * Rewritten 2026-09-26 after a live report ("the languages doesn't work very well"): a customer picked Yoruba from
 * the picker, got a Yoruba confirmation, then every later reply came back in English anyway. Root cause: the LLM
 * system prompt's language instruction (buildSystemPrompt, server/routers/nlp.ts) is driven by
 * `nlp_sessions.language` — a field that was only ever GUARDED from being overwritten by per-message re-detection
 * once a sticky lock existed (`!sticky && detectedLang !== session.language`); it was never actually SYNCED from
 * the sticky store in the first place, so it just kept whatever stale value (usually "english") it already had
 * from before the pick.
 *
 * The original version of this test only exercised a hand-reimplemented copy of that guard condition against a
 * directly-seeded nlp_sessions row — real code was never called, so it could not have caught this bug. This
 * version drives the real picker flow (server/services/useCases.ts) and the real nlp.processMessage session sync
 * (server/routers/nlp.ts), and inspects the actual system prompt the LLM mock received.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J446",
  name: "QA-064 a language-menu pick takes effect on the very next message, not just future ones",
  feature: "W47 buyer locale stability",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const i18n = await import("../../server/services/i18n");
    const { llm } = await import("../metaMock");
    const phone = world.newPhone("446");
    await world.grantConsent(phone);

    // 1. Enter free-text ordering mode — creates the nlp_sessions row, defaulting to "english" (same setup J551
    //    uses: "hi" alone never reaches nlp.processMessage, "shop" does).
    await world.text(phone, "shop");
    const [before] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(before?.language === "english", `setup: session starts english (got ${before?.language})`);

    // 2. Pick Yoruba through the REAL picker flow (server/services/useCases.ts) — exactly what the live screenshot
    //    showed: "language" opens the numbered menu, a name/alias reply selects it and locks the sticky locale.
    await world.text(phone, "language");
    await world.text(phone, "yoruba");
    const sticky = await i18n.getStickyLocale(TENANT_ID, phone);
    assert(sticky === "yo", `sticky locale set by the picker (got ${sticky})`);

    // 3. The picker resets the customer to the main numbered menu (same reason J551 re-sends "shop" after seeding
    //    a stuck language) — go back into free-text mode, then send an ORDINARY ENGLISH-LOOKING message that
    //    reaches the LLM path. "menu_3" is the exact live reproducer from J548/J551: plain-English-looking text
    //    that clears the deterministic classifier and reaches classifyDeterministically's LLM fallback.
    await world.text(phone, "shop");
    const beforeCalls = llm.calls.length;
    const beforeOutbound = world.outbound.ofType("text", phone).length;
    await world.text(phone, "menu_3");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeOutbound, 20000, "reply to menu_3");

    // 4. The session's stored language must ALREADY reflect the sticky pick on THIS message — not two messages
    //    from now, not never (the exact live bug).
    const [after] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(after?.language === "yoruba", `session language must sync to the sticky pick on the very next message (got ${after?.language})`);

    // 5. And the actual system prompt sent to the LLM for that message carried the Yoruba instruction — the real
    //    mechanism a customer's live reply language depends on, not just an incidental DB field.
    const newCalls = llm.calls.slice(beforeCalls);
    assert(newCalls.length > 0, "the LLM mock received at least one completion request for menu_3");
    const systemPrompt = newCalls[newCalls.length - 1]?.body?.messages?.[0]?.content ?? "";
    assertIncludes(systemPrompt, "Respond in Yoruba", "system prompt instructs the LLM to reply in Yoruba");

    // 6. Sticky still wins over re-detection in EITHER direction — a confidently-English message afterward must
    //    NOT flip the session back to English (the guard's original purpose; J551 covers the no-sticky
    //    self-correction direction).
    await world.text(phone, "I want to buy something please, thank you");
    const [stillYoruba] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(stillYoruba?.language === "yoruba", `a sticky pick must not be overwritten by re-detection (got ${stillYoruba?.language})`);
  },
};
