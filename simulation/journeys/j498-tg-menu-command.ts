/**
 * === W50 CHANNELS (Coder A) ===
 * J498 — TG /menu command renders the tenant menu engine (settings.waMenu)
 * as a Telegram inline-keyboard list with menu_<n> callback ids.
 */
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J498",
  name: "telegram /menu command renders the shared menu engine",
  feature: "W50 TG menu parity: /menu → sendTelegramList(menu_<n>)",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    const chatId = "880498";
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    const before = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970498,
      message: { message_id: 1498, from: { id: 770498, first_name: "Menu" }, chat: { id: Number(chatId), type: "private" }, date: 1788000498, text: "/menu" },
    });
    assert(res.status === 200, `webhook ack 200 (got ${res.status})`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "menu keyboard sent");
    const sent = tg.callsFor("sendMessage").at(-1)!;
    const kb = sent.body?.reply_markup?.inline_keyboard ?? [];
    assert(kb.length >= 2, "menu renders as an inline keyboard");
    assert(kb[0][0]?.callback_data === "menu_1", `first row id menu_1 (got ${kb[0][0]?.callback_data})`);
    assertIncludes(String(sent.body?.text ?? ""), "Shop", "menu text lists the shop use case");
  },
};
