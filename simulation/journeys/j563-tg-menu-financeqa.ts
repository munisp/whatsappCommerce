// === W55 parity (PARITY-4) ===
/**
 * J563 — TG text "menu" + financeQa parity:
 *   1. Text "menu" (no slash) renders the SAME tenant menu engine as /menu
 *      (inline keyboard via sendTelegramMenu).
 *   2. A localized menu word ("accueil" with a sticky fr locale) maps to the
 *      same menu via matchLocalizedIntent (W55 pre-NLP seam).
 *   3. Merchant finance Q&A ("who owes me most") answers deterministically
 *      over TG — previously WA-only inside handleConversationalInbound.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J563",
  name: "TG text menu (en + localized) + financeQa keyword parity",
  feature: "W55 parity: TG menu/financeQa text keywords (PARITY-4)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);

    const chatId = "95563001";
    const phone = world.newPhone("563");
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId, phoneE164: phone, linkedVia: "j563_seed",
    }).onConflictDoNothing();
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    // ── 1. text "menu" → inline-keyboard menu (same engine as /menu) ────
    const res1 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(9605630, chatId, 770563, "menu"));
    assert(res1.status === 200, "TG webhook acks menu text");
    await world.waitFor(() => tg.callsFor("sendMessage").some((c) =>
      String(c.body?.chat_id) === chatId && c.body?.reply_markup?.inline_keyboard),
      10000, "text menu renders the TG inline-keyboard menu");

    // ── 2. localized menu word (sticky fr locale → "accueil") ───────────
    const i18n = await import("../../server/services/i18n");
    await i18n.setStickyLocale(TENANT_ID, `telegram:${chatId}`, "fr");
    const beforeFr = tg.callsFor("sendMessage").length;
    const res2 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(9605631, chatId, 770563, "accueil"));
    assert(res2.status === 200, "TG webhook acks localized menu word");
    await world.waitFor(() =>
      tg.callsFor("sendMessage").slice(beforeFr).some((c) =>
        String(c.body?.chat_id) === chatId && c.body?.reply_markup?.inline_keyboard),
      10000, "localized menu word maps to the menu engine");

    // ── 3. financeQa keyword → deterministic answer over TG ─────────────
    const beforeFq = tg.callsFor("sendMessage").length;
    const res3 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(9605632, chatId, 770563, "who owes me most"));
    assert(res3.status === 200, "TG webhook acks finance question");
    await world.waitFor(() =>
      tg.callsFor("sendMessage").slice(beforeFq).some((c) =>
        String(c.body?.chat_id) === chatId && /owes you|invoice/i.test(String(c.body?.text ?? ""))),
      10000, "financeQa answers over TG (no LLM fallback)");
  },
};
