/**
 * === W37 telegram (Coder B) ===
 * J236 — callback_query → WA-equivalent interactive payload + ack + clear.
 *
 *  1. normalizeUpdate synthesizes the SAME interactive-reply payload the WA
 *     button path produces: { type:"interactive", interactiveType:
 *     "button_reply", id: <callback_data> } — the existing id grammar
 *     (`menu_<n>`) is preserved verbatim.
 *  2. The Bot API gets answerCallbackQuery (ack within Telegram's window)
 *     and editMessageReplyMarkup with an empty inline_keyboard (keyboard
 *     cleared after tap, preventing double-tap).
 *  3. The tapped id is dispatched through the shared NLP engine under the
 *     `telegram:<chat_id>` session (a reply is sent, session row keyed by
 *     the telegram session key).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J236",
  name: "telegram callback_query → WA-equivalent interactive payload + ack + keyboard cleared",
  feature: "W37 telegram inbound normalization",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    const { normalizeUpdate } = await import("../../server/services/telegramInbound");
    await ensureTelegramConfig(world);

    // 1. Pure normalization shape (WA-equivalent interactive payload).
    const chatId = "880236";
    const fromId = 770236;
    const update = {
      update_id: 970236,
      callback_query: {
        id: "cbq-970236",
        from: { id: fromId, first_name: "Tg", username: "tguser236" },
        message: { message_id: 4242, chat: { id: Number(chatId), type: "private" }, date: 1788000000 },
        data: "menu_1",
      },
    };
    const ev = normalizeUpdate(update);
    assert(ev?.kind === "callback", "update must normalize to a callback event");
    const interactive = (ev as any).interactive;
    assert(interactive?.type === "interactive", "payload type must be interactive");
    assert(interactive?.interactiveType === "button_reply", "must synthesize button_reply");
    assert(interactive?.id === "menu_1", `id grammar must be preserved verbatim, got ${interactive?.id}`);

    // Pre-grant telegram consent so the tapped id reaches the NLP engine.
    const { recordConsent } = await import("../../server/services/consent");
    const db = world.db;
    await recordConsent(db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    // 2 + 3. Live webhook: ack + keyboard cleared + dispatch.
    const ackBefore = tg.callsFor("answerCallbackQuery").length;
    const editBefore = tg.callsFor("editMessageReplyMarkup").length;
    const msgBefore = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, update);
    assert(res.status === 200, `webhook must ack 200, got ${res.status}`);

    await world.waitFor(() => tg.callsFor("answerCallbackQuery").length > ackBefore, 5000, "answerCallbackQuery ack");
    const ack = tg.callsFor("answerCallbackQuery").at(-1)!;
    assert(ack.body?.callback_query_id === "cbq-970236", "answerCallbackQuery must reference the query id");

    await world.waitFor(() => tg.callsFor("editMessageReplyMarkup").length > editBefore, 5000, "keyboard clear");
    const edit = tg.callsFor("editMessageReplyMarkup").at(-1)!;
    assert(edit.body?.message_id === 4242, "editMessageReplyMarkup must target the tapped message");
    assert(String(edit.body?.chat_id) === chatId, "editMessageReplyMarkup chat_id");
    assert(
      Array.isArray(edit.body?.reply_markup?.inline_keyboard) && edit.body.reply_markup.inline_keyboard.length === 0,
      "keyboard must be cleared to an empty inline_keyboard",
    );

    // Dispatch reached the shared engine: a reply went out and the session is
    // keyed telegram:<chat_id>.
    await world.waitFor(() => tg.callsFor("sendMessage").length > msgBefore, 5000, "nlp reply after tap");
    const sess = await world.pg.query(
      `SELECT "waPhoneNumber" FROM nlp_sessions WHERE "tenantId" = $1 AND "waPhoneNumber" = $2`,
      [TENANT_ID, `telegram:${chatId}`],
    );
    const sessRows = (sess as any).rows ?? sess;
    assert(sessRows.length === 1, "nlp session must key on telegram:<chat_id>");
  },
};
