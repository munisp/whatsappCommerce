/**
 * J471 — Telegram must do what WhatsApp does: the menu engine + interactive taps.
 *
 * The same six inputs that used to diverge (measured 2026-09-25, tracked as Group X on the QA tracker) are sent
 * through both channels and the outcomes are compared:
 *   hi / menu / help / catalog  → the welcome menu (not a "didn't understand" fallback)
 *   2 (orders)                  → the same "no orders yet" reply
 *   3 (human agent)             → the same handoff reply, and the SAME admin alert
 * Then a menu button tap on Telegram (the inline-keyboard equivalent of a WhatsApp list/button reply) is checked to
 * resolve through the SAME numbered-selection path, and a stray tap after the flow finished (no menu on screen) is
 * checked to fall through to the assistant rather than being silently swallowed.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, ADMIN_PHONE, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

/** The welcome menu's own words (waMenu.ts's default greeting) — present on both channels once the engine renders it. */
const MENU_MARKER = "How can we help";

export const journey: Journey = {
  id: "J471",
  name: "Telegram parity: menu engine + interactive taps match WhatsApp for the same inputs",
  feature: "Telegram/WhatsApp parity — menu engine",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const { recordConsent } = await import("../../server/services/consent");
    await ensureTelegramConfig(world);
    // Other journeys (J335/J336/J346/J351) repoint settings.adminPhone at their own test merchant and never restore
    // it — set it back explicitly rather than assume the tenant's original default survived to this point.
    await world.patchTenantSettings({ adminPhone: ADMIN_PHONE });

    const waPhone = world.newPhone("j471wa");
    const chatId = "471001";
    const tgKey = `telegram:${chatId}`;
    let uid = 4710001;
    const tgFromId = 4710099;

    await world.grantConsent(waPhone);
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: tgKey, channel: "telegram", granted: true });

    const lastWa = () => bodyText(world.outbound.lastTo(waPhone));
    const lastTg = () =>
      String(tg.callsFor("sendMessage").filter((c) => String(c.body?.chat_id) === chatId).pop()?.body?.text ?? "");
    const sendTg = (text: string) => tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, tgFromId, text));

    // 1. hi / menu / help / catalog: WhatsApp already shows the menu; Telegram must now match, not fall back to
    //    "Sorry, I didn't quite get that" (the pre-fix behavior every one of these four used to hit).
    for (const word of ["hi", "menu", "help", "catalog"]) {
      await world.text(waPhone, word);
      const wa = lastWa();
      assertIncludes(wa, MENU_MARKER, `WhatsApp "${word}" must show the welcome menu`);

      await sendTg(word);
      await world.settle();
      const tgReply = lastTg();
      assert(!/didn.t quite get that/i.test(tgReply), `Telegram "${word}" must not fall back to the NLP miss (got: ${tgReply.slice(0, 80)})`);
      assertIncludes(tgReply, MENU_MARKER, `Telegram "${word}" must show the SAME welcome menu as WhatsApp`);
    }

    // 2. Orders (menu option 2): no orders yet, worded the same way on both channels.
    await world.text(waPhone, "2");
    const waOrders = lastWa();
    assertIncludes(waOrders, "couldn't find any orders", "WhatsApp order lookup with none placed");

    await sendTg("2");
    await world.settle();
    const tgOrders = lastTg();
    assert(!/didn.t quite get that/i.test(tgOrders), "Telegram order lookup must not fall back to the NLP miss");
    assertIncludes(tgOrders, "couldn't find any orders", "Telegram order lookup must match WhatsApp's wording");

    // 3. Human agent (menu option 3): same handoff reply, and the SAME admin alert path (notifyTenantAdmin →
    //    WhatsApp to the tenant's configured admin phone regardless of which channel the buyer used).
    const adminBefore = world.outbound.toPhone(ADMIN_PHONE).length;
    await world.text(waPhone, "3");
    const waHandoff = lastWa();
    assertIncludes(waHandoff, "human agent", "WhatsApp handoff reply");
    await world.waitFor(() => world.outbound.toPhone(ADMIN_PHONE).length > adminBefore, 5000, "admin alert after WA handoff");
    const adminAfterWa = world.outbound.toPhone(ADMIN_PHONE).length;

    await sendTg("3");
    await world.settle();
    const tgHandoff = lastTg();
    assert(!/didn.t quite get that/i.test(tgHandoff), "Telegram handoff must not fall back to the NLP miss");
    assertIncludes(tgHandoff, "human agent", "Telegram handoff reply must match WhatsApp's wording");
    await world.waitFor(() => world.outbound.toPhone(ADMIN_PHONE).length > adminAfterWa, 5000, "admin alert after TG handoff");
    const lastAdminAlert = bodyText(world.outbound.toPhone(ADMIN_PHONE).at(-1));
    assertIncludes(lastAdminAlert, tgKey, "the admin alert for a Telegram handoff must identify the Telegram chat, not a phone");

    // 4. A menu tap on Telegram resolves through the SAME numbered-selection path a typed "2" does — the inline
    //    keyboard is not just decoration over a parallel, unconnected code path.
    await sendTg("menu");
    await world.settle();
    const menuMsg = tg.callsFor("sendMessage").filter((c) => String(c.body?.chat_id) === chatId).pop();
    const buttons = (menuMsg?.body?.reply_markup?.inline_keyboard ?? []).flat();
    assert(buttons.length > 0, "the Telegram welcome menu must render as tappable buttons, not text-only");
    const trackBtn = buttons.find((b: any) => /track|order/i.test(b.text ?? ""));
    assert(!!trackBtn?.callback_data, "one of the menu buttons must be the order-tracking option");
    const cbTapped = trackBtn.callback_data as string;

    const editBefore = tg.callsFor("editMessageReplyMarkup").length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: uid++,
      callback_query: {
        id: `cbq-${uid}`,
        from: { id: tgFromId, first_name: "Tg" },
        message: { message_id: menuMsg!.body.message_id ?? 999, chat: { id: Number(chatId), type: "private" }, date: 1788000000 },
        data: cbTapped,
      },
    });
    await world.settle();
    assert(tg.callsFor("editMessageReplyMarkup").length > editBefore, "a menu tap must clear its own keyboard (no double-tap)");
    const tapReply = lastTg();
    assertIncludes(tapReply, "couldn't find any orders", "tapping the order-tracking button must give the same reply as typing its number");

    // 5. A stray tap once no menu is on screen (id unknown to the engine) must fall through to the assistant, not
    //    be silently dropped — same as an unrecognized WhatsApp interactive reply title falling through to NLP.
    const nlpBefore = tg.callsFor("sendMessage").filter((c) => String(c.body?.chat_id) === chatId).length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: uid++,
      callback_query: {
        id: `cbq-${uid}`,
        from: { id: tgFromId, first_name: "Tg" },
        message: { message_id: 12345, chat: { id: Number(chatId), type: "private" }, date: 1788000000 },
        data: "menu_9",
      },
    });
    await world.settle();
    assert(
      tg.callsFor("sendMessage").filter((c) => String(c.body?.chat_id) === chatId).length > nlpBefore,
      "an unrecognized menu tap must still get a reply (falls through to the assistant, never silently dropped)",
    );

    // 6. FAQ / gift-card style answers already matched before this fix and must still match (no regression on the
    //    channel-agnostic assistant path).
    await world.text(waPhone, "what are your opening hours");
    const waFaq = lastWa();
    await sendTg("what are your opening hours");
    await world.settle();
    const tgFaq = lastTg();
    assert(waFaq.length > 0 && tgFaq.length > 0, "both channels must answer the opening-hours question");

    // Session sanity: the Telegram side of this journey ran entirely under its own session key, never touching the
    // WhatsApp phone's consent/session rows.
    const [waConsent] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, waPhone), eq(schema.consents.channel, "whatsapp")));
    const [tgConsent] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, tgKey), eq(schema.consents.channel, "telegram")));
    assert(!!waConsent && !!tgConsent, "each channel keeps its own consent row");
  },
};
