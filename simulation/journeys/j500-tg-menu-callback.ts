/**
 * === W50 CHANNELS (Coder A) ===
 * J500 — TG callback menu_2 routes through handleInteractiveInbound (the WA
 * menu-engine resolution), NOT raw dispatchToNlp: tapping "Track my order"
 * returns the deterministic track-use-case reply.
 */
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J500",
  name: "telegram menu_<n> callback resolves through the menu engine",
  feature: "W50 TG menu parity: callback → handleInteractiveInbound",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    const chatId = "880500";
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    // handleInteractiveInbound → handleConversationalInbound consults the
    // GLOBAL (channel-agnostic) consent row too.
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, granted: true });

    const before = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970500,
      callback_query: {
        id: "cbq-970500",
        from: { id: 770500, first_name: "Tap", username: "tg500" },
        message: { message_id: 1500, chat: { id: Number(chatId), type: "private" }, date: 1788000500 },
        data: "menu_2", // Track my order
      },
    });
    assert(res.status === 200, `webhook ack 200 (got ${res.status})`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "menu-engine reply");
    const reply = String(tg.callsFor("sendMessage").at(-1)?.body?.text ?? "");
    // The deterministic track handler reply — proof the tap went through the
    // menu engine (handleConversationalInbound numeric selection), not NLP.
    assertIncludes(reply, "couldn't find any orders", "menu_2 resolves to the track use case");
  },
};
