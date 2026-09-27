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
    // === W50 CHANNELS === the tap first passes the menu engine's consent
    // gate (global, channel-agnostic) before falling through to NLP.
    await recordConsent(db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, granted: true });

    // 2 + 3. Live webhook: ack + keyboard cleared + dispatch.
    // === W50 CHANNELS === menu_<n> ids now route through the menu engine
    // (handleInteractiveInbound — see J500); use a non-menu id here so the
    // tap still falls through to the raw NLP dispatch this journey asserts.
    // === W53 RESIDUALS (J237 DEFLAKE root cause) === the live update_id
    // MUST stay inside J236's own id namespace: the webhook dedupe ledger
    // (processed_webhook_events, keyed `tg:<update_id>`) persists across
    // journeys in a shared world, and 970237 collided with J237's first
    // contact-share update — J237's update was then dropped as a duplicate
    // and its "binding confirmation" waitFor timed out under full-suite
    // ordering (J236 always runs immediately before J237).
    const liveUpdate = {
      ...update,
      update_id: 960236,
      callback_query: { ...update.callback_query, id: "cbq-960236", data: "catalog_ai:noop-236" },
    };
    const ackBefore = tg.callsFor("answerCallbackQuery").length;
    const editBefore = tg.callsFor("editMessageReplyMarkup").length;
    const msgBefore = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, liveUpdate);
    assert(res.status === 200, `webhook must ack 200, got ${res.status}`);

    await world.waitFor(() => tg.callsFor("answerCallbackQuery").length > ackBefore, 5000, "answerCallbackQuery ack");
    const ack = tg.callsFor("answerCallbackQuery").at(-1)!;
    assert(ack.body?.callback_query_id === "cbq-960236", "answerCallbackQuery must reference the query id");

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
