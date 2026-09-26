/**
 * J481 — a session stuck on the wrong language self-corrects, instead of staying wrong forever.
 *
 * Found live 2026-09-25 (same screenshots as the shortage-recovery bug): a session got flagged "igbo" at some
 * point — from the OLD, since-fixed crude substring-hint detector, though a false positive could always happen in
 * principle even with a good detector — and every reply after that stayed in Igbo, including replies to messages
 * that were plainly English, with no way for the customer to escape it. The sticky-language update in
 * `server/routers/nlp.ts` only ever moved a session AWAY from English (`detectedLang !== "english"`), never back —
 * a one-way ratchet. Fixed to sync unconditionally when not explicitly sticky-locked.
 *
 * Seeds a session already stuck this way (bypassing the need to first trigger the old bug, which no longer exists
 * to trigger) to prove the self-correction, not the original detection.
 */
import { and, eq } from "drizzle-orm";
import { assert, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J481",
  name: "a session stuck on a wrong language self-corrects on the next ordinary English message",
  feature: "sticky session language is no longer a one-way ratchet away from English",
  async run(world: World) {
    const { llm } = await import("../metaMock");
    const schema = await import("../../drizzle/schema");

    const phone = world.newPhone("j481");
    await world.grantConsent(phone);

    // Get a real nlp_sessions row into existence the normal way, then flip it to "igbo" directly — reproducing a
    // session that's already stuck, the same state the live user's session was found in. "hi" alone never reaches
    // nlp.processMessage (it's a menu keyword, handled entirely by the deterministic menu engine) — "shop" does,
    // since shopHandler calls nlp.processMessage internally to enter free-text ordering mode.
    await world.text(phone, "shop");
    await world.db.update(schema.nlpSessions)
      .set({ language: "igbo" })
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    const [stuck] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(stuck?.language === "igbo", "setup: session is stuck on igbo before the real check");

    llm.forceNetworkError = true;
    try {
      // Not an ordinary FAQ-style question — nlp.ts has its own FAQ shortcut (settings.faq) BEFORE the LLM call,
      // which would answer this without ever touching session.language, proving nothing about the fix. "menu_3" —
      // the exact live reproducer from J478 — reliably reaches classifyDeterministically's plain-English fallback.
      const before = world.outbound.ofType("text", phone).length;
      await world.text(phone, "menu_3");
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 20000, "reply despite LLM down");
      const reply = bodyText(world.outbound.lastOfType("text", phone));
      assert(!/[ẹọṣịụàáèéìíòóùúẖƙƴ]/i.test(reply), `reply must self-correct back to English, not stay stuck in Igbo forever (got: ${reply.slice(0, 150)})`);
    } finally {
      llm.forceNetworkError = false;
    }

    const [fixed] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(fixed?.language === "english", `the session's stored language must actually update back to english, not just this one reply happening to be in English (got: ${fixed?.language})`);
  },
};
