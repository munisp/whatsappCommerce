// === W54 capabilities (CAP-2) ===
/**
 * J559 — USSD depth localized: the "balance" keyword opens the W54 balances
 * menu in French and Nigerian Pidgin pcm (session-locale pinned — the same
 * deterministic seam J537 uses for picker-less locales), and the loyalty
 * balance query answers in the pinned locale, all through the REAL
 * nlp.processMessage ussdMode path. English is the control.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { eq } from "drizzle-orm";

export const journey: Journey = {
  id: "J559",
  name: "USSD balances menu + loyalty balance in fr + pcm (+en control)",
  feature: "W54 capabilities: USSD depth localization",
  async run(world: World) {
    const { appRouter } = await import("../../server/routers");
    const { nlpSessions } = await import("../../drizzle/schema");
    const caller = appRouter.createCaller({ user: null } as any);

    // Seed points so every locale renders a non-zero balance.
    const phone = world.newPhone("552");
    const { awardPoints } = await import("../../server/services/loyalty");
    await awardPoints({ tenantId: TENANT_ID, customerPhone: phone, points: 7, reason: "J559 seed" }, world.db as any);

    const pinAndAsk = async (sessionLanguage: string, message: string) => {
      const first = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone, message: "hi", ussdMode: true,
      });
      await world.db.update(nlpSessions)
        .set({ language: sessionLanguage })
        .where(eq(nlpSessions.id, first.sessionId));
      return caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone, message, ussdMode: true,
      });
    };

    // ── balances menu per locale ──
    const enMenu = await pinAndAsk("english", "balance");
    assert(enMenu.intent === "ussd_menu", "en balance → menu path");
    assert(String(enMenu.reply).startsWith("Balance queries"), `en menu (got ${String(enMenu.reply).slice(0, 80)})`);
    assert(/1\. .+\n2\. .+\n3\. /s.test(String(enMenu.reply)), "en 3 numbered options");

    const frMenu = await pinAndAsk("french", "balance");
    assert(String(frMenu.reply).startsWith("Soldes"), `fr menu (got ${String(frMenu.reply).slice(0, 80)})`);
    assert(String(frMenu.reply).includes("Points fidélité"), "fr loyalty option label");

    const pcmMenu = await pinAndAsk("pcm", "balance");
    assert(String(pcmMenu.reply).startsWith("Balance check"), `pcm menu (got ${String(pcmMenu.reply).slice(0, 80)})`);
    assert(String(pcmMenu.reply).includes("Savings circles"), "pcm savings option label");

    // ── loyalty balance query per locale ──
    const enBal = await pinAndAsk("english", "loyalty");
    assert(enBal.intent === "ussd_balance", "en loyalty → balance intent");
    assert(String(enBal.reply).includes("7"), `en balance carries points (got ${String(enBal.reply).slice(0, 120)})`);

    const frBal = await pinAndAsk("french", "loyalty");
    assert(String(frBal.reply).startsWith("Solde de points fidélité"), `fr balance localized (got ${String(frBal.reply).slice(0, 120)})`);
    assert(String(frBal.reply).includes("7"), "fr balance carries points");

    const pcmBal = await pinAndAsk("pcm", "loyalty");
    assert(String(pcmBal.reply).startsWith("Loyalty points balance"), `pcm balance localized (got ${String(pcmBal.reply).slice(0, 120)})`);
    assert(String(pcmBal.reply).includes("7"), "pcm balance carries points");

    // ── savings empty state localized (fr) ──
    const stranger = world.newPhone("552s");
    const first = await caller.nlp.processMessage({
      tenantId: TENANT_ID, waPhoneNumber: stranger, message: "hi", ussdMode: true,
    });
    await world.db.update(nlpSessions).set({ language: "french" }).where(eq(nlpSessions.id, first.sessionId));
    const frNone = await caller.nlp.processMessage({
      tenantId: TENANT_ID, waPhoneNumber: stranger, message: "savings", ussdMode: true,
    });
    assert(frNone.intent === "ussd_balance", "fr savings → balance intent");
    assert(String(frNone.reply).includes("cercle d'épargne"), `fr savings empty state (got ${String(frNone.reply).slice(0, 120)})`);
  },
};
// === END W54 capabilities ===
