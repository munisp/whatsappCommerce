/**
 * J477 — the actual thing a customer wants from Telegram: place an order and pay, start to finish, through the
 * SAME NLP checkout pipeline WhatsApp uses. /start → menu → shop → add to cart → confirm → choose pickup → the
 * order is created and the SAME order-action card (Track / Pay / Cancel) WhatsApp gets is delivered as a Telegram
 * inline keyboard → tapping Pay resolves through the SAME handleOrderAction as a WhatsApp tap, on the correct order.
 * This path (telegramInbound.ts's dispatchToNlp order-card/product-image follow-ups) was written but never actually
 * exercised by a journey until now — worth a dedicated real run, not just a read of the code, before calling it done.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const journey: Journey = {
  id: "J477",
  name: "telegram: place an order and pay, end to end (order-action card + pay tap)",
  feature: "Telegram/WhatsApp parity — order card + payment follow-up",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    const schema = await import("../../drizzle/schema");
    await ensureTelegramConfig(world);
    const { recordConsent } = await import("../../server/services/consent");

    const chatId = "477001";
    const fromId = 4770099;
    const sessionKey = `telegram:${chatId}`;
    let uid = 4770001;

    const sendsToChat = () => tg.callsFor("sendMessage").filter((c: any) => String(c.body?.chat_id) === chatId);
    const lastText = () => String(sendsToChat().at(-1)?.body?.text ?? "");
    const send = (text: string) => tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, fromId, text));

    await recordConsent(world.db, { tenantId: TENANT_ID, phone: sessionKey, channel: "telegram", granted: true });
    // ensureTelegramConfig's settings write and the webhook's own getTelegramConfig read can race right after each
    // other (found while writing this journey — a POST fired immediately after setup intermittently saw a stale,
    // not-yet-visible config and 404'd "not-found"); wait for the SAME lookup the webhook does to actually resolve
    // before sending anything, rather than assume the write is visible the instant its promise resolves.
    const { getTelegramConfig } = await import("../../server/services/telegramInbound");
    await world.waitFor(async () => {
      const cfg = await getTelegramConfig(world.db, TENANT_ID);
      return !!(cfg?.enabled && cfg.webhookSecret && cfg.botToken);
    }, 5000, "telegram config visible to a fresh read");

    // 1. Enter the shop flow via the menu engine (as if the buyer tapped the "Shop" button).
    world.llm.when("place a telegram order [j477]", {
      reply: "Added to your cart!", intent: "add_to_cart", nextState: "add_to_cart",
      extractedItems: [{ product: "Jollof Rice", quantity: 2 }],
      extractedProduct: null, extractedQuantity: null, extractedAddress: null, confidence: 0.95,
    });
    world.llm.when("confirm the telegram order [j477]", {
      reply: "Let me confirm that.", intent: "confirm_order", nextState: "checkout_confirm",
      extractedItems: [], extractedProduct: null, extractedQuantity: null, extractedAddress: null, confidence: 0.95,
    });

    let before = sendsToChat().length;
    const shopRes = await send("shop");
    assert(shopRes.status === 200, `shop message must ack 200, got ${shopRes.status} ${JSON.stringify(shopRes.json)}`);
    await world.waitFor(() => sendsToChat().length > before, 15000, "shop handoff reply");

    before = sendsToChat().length;
    await send("place a telegram order [j477]");
    await world.waitFor(() => sendsToChat().length > before, 15000, "add-to-cart reply");
    assertIncludes(lastText(), "cart", "add-to-cart acknowledged");

    before = sendsToChat().length;
    await send("confirm the telegram order [j477]");
    await world.waitFor(() => sendsToChat().length > before, 15000, "confirm reply");

    await sleep(5); // order numbers are Date.now()-based — avoid same-ms collisions with other journeys

    // 2. Fulfillment choice ("1" = pickup) — this is checkout state, NOT a menu digit; must reach NLP, not the
    //    menu engine (the exact regression this test exists to catch if the ordering in telegramInbound.ts breaks).
    before = sendsToChat().length;
    await send("1");
    await world.waitFor(() => sendsToChat().length > before + 1, 15000, "order summary + order-action card");

    const orders = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, sessionKey)))
      .orderBy(schema.orders.createdAt);
    const order = orders.at(-1);
    assert(!!order, `an order must have been created for ${sessionKey} (got ${orders.length} orders)`);

    // 3. The order-action card (Track / Pay / Cancel) must have gone out as a Telegram inline keyboard, not just
    //    text — same as WhatsApp gets buttons, not a typed instruction.
    const cardMsg = sendsToChat().slice(before).find((c: any) =>
      Array.isArray(c.body?.reply_markup?.inline_keyboard) &&
      c.body.reply_markup.inline_keyboard.flat().some((b: any) => typeof b.callback_data === "string" && b.callback_data.startsWith(`order_pay:${order!.id}`)));
    assert(!!cardMsg, "an order-action card with a Pay button for THIS order must be sent");

    // 4. Tapping Pay resolves through the SAME handleOrderAction a WhatsApp tap would hit, on the correct order —
    //    never someone else's, never a generic NLP miss.
    const payId = `order_pay:${order!.id}`;
    before = sendsToChat().length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: uid++,
      callback_query: {
        id: `cbq-${uid}`, from: { id: fromId, first_name: "Tg" },
        message: { message_id: 55001, chat: { id: Number(chatId), type: "private" }, date: 1788000000 },
        data: payId,
      },
    });
    await world.waitFor(() => sendsToChat().length > before, 15000, "reply after Pay tap");
    const payReply = lastText();
    assert(
      /already paid|pay here|payment|link/i.test(payReply) && !/didn.t quite get that/i.test(payReply),
      `Pay tap must resolve to a real order-action reply, not an NLP miss (got: ${payReply.slice(0, 150)})`,
    );
  },
};
