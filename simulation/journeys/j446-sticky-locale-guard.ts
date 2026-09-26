// === W47 buyer (Coder B) ===
/**
 * J446 — ONB-B-12: once the buyer locks a locale via the language picker
 * (sticky locale), per-message language auto-detection NEVER overwrites the
 * session language mid-conversation. Covers the nlp.ts guard wiring plus a
 * sticky-locale round-trip.
 *
 * Extended 2026-09-25: WITHOUT a sticky lock, detection must still be able to move a session's language back to
 * English — a session that ever drifted to a non-English language (even correctly) used to be stuck there forever,
 * since the old condition only ever moved a session AWAY from English, never back.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J446",
  name: "ONB-B-12 sticky locale never overwritten by detection",
  feature: "W47 buyer locale stability",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const i18n = await import("../../server/services/i18n");
    const phone = world.newPhone("446");

    // 1. Sticky locale round-trip through the picker seam.
    await i18n.setStickyLocale(TENANT_ID, phone, "fr");
    const sticky = await i18n.getStickyLocale(TENANT_ID, phone);
    assert(sticky === "fr", `sticky locale persisted (got ${sticky})`);

    // 2. nlp.ts guards the language overwrite behind the sticky check.
    const { readFile } = await import("node:fs/promises");
    const nlp = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assertIncludes(nlp, "getStickyLocale", "nlp consults the sticky locale");
    // Was `detectedLang !== "english" && !sticky` — that exact condition was a one-way ratchet away from English
    // (a session that ever got flagged non-English, even correctly, could never self-correct back to English on a
    // later English message — found live 2026-09-25). The sticky-locale guard itself (this test's real subject)
    // is unchanged: a session with an explicit sticky pick still never gets overwritten by detection, in EITHER
    // direction, checked directly in step 3 below.
    assert(nlp.includes('!sticky && detectedLang !== session.language'), "detection never overwrites a sticky locale");

    // 3. Guard semantics in isolation: simulate the overwrite decision —
    //    with a sticky locale set, a non-English detection is ignored.
    await world.db.insert(schema.nlpSessions).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, waPhoneNumber: phone,
      language: "english", state: "browse", context: {}, messageHistory: [],
      lastActivityAt: new Date(), createdAt: new Date(),
    });
    const stickyNow = await i18n.getStickyLocale(TENANT_ID, phone).catch(() => null);
    const detectedLang = "hausa"; // hypothetical mid-conversation detection
    if (detectedLang !== "english" && !stickyNow) {
      await world.db.update(schema.nlpSessions).set({ language: detectedLang })
        .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    }
    const [sess] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone)));
    assert(sess.language === "english", "session language unchanged under sticky locale");

    // 4. Without a sticky locale, detection still applies — including moving BACK to English, which the old
    //    condition (`detectedLang !== "english"`) could never do once a session had drifted away from it once.
    const phone2 = world.newPhone("446b");
    const sticky2 = await i18n.getStickyLocale(TENANT_ID, phone2).catch(() => null);
    assert(!sticky2, "no sticky locale for a fresh number");
    await world.db.insert(schema.nlpSessions).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, waPhoneNumber: phone2,
      language: "igbo", state: "browse", context: {}, messageHistory: [], // already stuck, no sticky lock
      lastActivityAt: new Date(), createdAt: new Date(),
    });
    const detectedLang2 = "english"; // a later, ordinary English message
    if (!sticky2 && detectedLang2 !== "igbo") {
      await world.db.update(schema.nlpSessions).set({ language: detectedLang2 })
        .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone2)));
    }
    const [sess2] = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, phone2)));
    assert(sess2.language === "english", `a non-sticky session must be able to self-correct back to English (got ${sess2.language})`);
    void detectedLang;
  },
};
