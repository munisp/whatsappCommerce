/**
 * === W50 CHANNELS (Coder A) ===
 * J499 — TG text "menu" keyword renders the tenant menu engine keyboard
 * (same as /menu), instead of falling into the NLP fallback.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J499",
  name: "telegram menu keyword renders the shared menu engine",
  feature: "W50 TG menu parity: 'menu' keyword → menu keyboard",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    const chatId = "880499";
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    const before = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970499,
      message: { message_id: 1499, from: { id: 770499, first_name: "Kw" }, chat: { id: Number(chatId), type: "private" }, date: 1788000499, text: "menu" },
    });
    assert(res.status === 200, `webhook ack 200 (got ${res.status})`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "menu keyboard sent");
    const sent = tg.callsFor("sendMessage").at(-1)!;
    const kb = sent.body?.reply_markup?.inline_keyboard ?? [];
    assert(kb.length >= 2, "keyword renders the menu keyboard");
    assert(kb[0][0]?.callback_data === "menu_1", "menu_<n> id grammar preserved");
  },
};
