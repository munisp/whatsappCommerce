// === W44 giftcards-referrals (Coder A) ===
/**
 * J339 — Chat balance check on BOTH channels: "gift card balance <CODE>"
 * answers deterministically (no LLM) on WhatsApp AND Telegram (telegram
 * inbound feeds the SAME nlp engine; the reply routes via channelSender).
 * A code-less follow-up reuses the session's lastGiftCardCode. Unknown codes
 * answer honestly. USE GIFT CARD in chat redeems against the open checkout.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J339",
  name: "gift card balance in chat — WhatsApp + Telegram parity",
  feature: "W44 gift_card balance intent on BOTH channels",
  async run(world: World) {
    const gift = await import("../../server/services/giftCards");
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j339");
    await world.grantConsent(phone);

    const card = await gift.issueGiftCard(TENANT_ID, { amountCents: 75000, customerId: phone, actor: "j339-merchant" });

    // ── WhatsApp: explicit code ──
    await world.text(phone, `gift card balance ${card.code}`);
    let reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, card.code, "WA reply carries the code");
    assertIncludes(reply, "₦750.00", "WA reply carries the balance");
    assertIncludes(reply, "active", "WA reply carries the status");

    // ── WhatsApp: code-less follow-up uses the session's remembered code ──
    await world.text(phone, "gift card balance");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "₦750.00", "code-less follow-up reuses last code");

    // ── WhatsApp: unknown code is honest ──
    await world.text(phone, "gift card balance GC-ZZZZ-9999");
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "couldn't find", "unknown code answered honestly");

    // ── Telegram: same engine, reply via channelSender ──
    await ensureTelegramConfig(world);
    const { tg } = await import("../metaMock");
    const { recordConsent } = await import("../../server/services/consent");
    const chatId = "880339";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    const msgBefore = tg.callsFor("sendMessage").length;
    const tgRes = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970339, chatId, 770339, `gift card balance ${card.code}`));
    assert(tgRes.status === 200, "telegram webhook acked");
    await world.waitFor(() => tg.callsFor("sendMessage").length > msgBefore, 10000, "telegram balance reply");
    const tgMsg = tg.callsFor("sendMessage").at(-1)!;
    assert(String(tgMsg.body?.chat_id) === chatId, "reply addressed to the tg chat");
    const tgText = String(tgMsg.body?.text ?? "");
    assert(tgText.includes(card.code), `TG reply carries the code (got ${tgText.slice(0, 120)})`);
    assert(tgText.includes("750.00"), "TG reply carries the balance");

    // ── Chat redemption against an open checkout (partial → PSP remainder) ──
    const buyer = world.newPhone("j339b");
    await world.grantConsent(buyer);
    const order = await createChatOrderViaNlp(world, buyer, {
      items: [{ product: "Grilled Chicken", quantity: 1 }], // ₦3,000
    });
    await world.text(buyer, `use gift card ${card.code}`);
    reply = bodyText(world.outbound.lastOfType("text", buyer));
    assertIncludes(reply, "Applied ₦750.00", "chat redeem applies the card");
    assertIncludes(reply, "Remaining to pay: ₦2,250.00", "honest PSP remainder");
    const fresh = await gift.getGiftCardByCode(TENANT_ID, card.code);
    assert(fresh!.balanceCents === 0 && fresh!.status === "depleted", "card drained by chat redeem");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
    assert(ord.paymentStatus !== "completed", "partial redeem leaves the order payable");
  },
};
