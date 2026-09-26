/**
 * J479 — the delivery-location request actually reaches Telegram.
 *
 * Found live 2026-09-25 (user screenshot): choosing "delivery" on Telegram showed the prompt text ("...or tap the
 * button below to share your location 📍") but no button ever appeared — the send was hardcoded to
 * `sendWhatsAppLocationRequest(tenantId, input.waPhoneNumber, ...)` regardless of channel, which on Telegram means
 * calling Meta's Graph API with `"telegram:<chat_id>"` as the recipient phone number. Meta rejects that silently
 * (the send is wrapped in a swallowed `.catch`), so nothing ever reached the customer — the free-text address path
 * still worked (which is why the order in the screenshot still completed), but the button promised in the prompt
 * text never existed. Fixed by routing through the channel-agnostic `channelSender.ts` facade instead.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J479",
  name: "telegram: choosing delivery sends a REAL location-request button, not a silently-dropped WhatsApp call",
  feature: "Telegram/WhatsApp parity — native location request",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    const schema = await import("../../drizzle/schema");
    await ensureTelegramConfig(world);
    const { recordConsent } = await import("../../server/services/consent");
    const { getTelegramConfig } = await import("../../server/services/telegramInbound");

    const chatId = "479001";
    const sessionKey = `telegram:${chatId}`;
    let uid = 4790001;
    await recordConsent(world.db, { tenantId: TENANT_ID, channel: "telegram", phone: sessionKey, granted: true });
    await world.waitFor(async () => {
      const cfg = await getTelegramConfig(world.db, TENANT_ID);
      return !!(cfg?.enabled && cfg.webhookSecret && cfg.botToken);
    }, 5000, "telegram config visible to a fresh read");

    const sendsToChat = () => tg.callsFor("sendMessage").filter((c: any) => String(c.body?.chat_id) === chatId);
    const send = (text: string) => tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, 4790099, text));

    world.llm.when("one jollof rice for j479", {
      reply: "Added to your cart!", intent: "add_to_cart", nextState: "add_to_cart",
      extractedItems: [{ product: "Jollof Rice", quantity: 1 }],
      extractedProduct: null, extractedQuantity: null, extractedAddress: null, confidence: 0.95,
    });
    world.llm.when("confirm it for j479", {
      reply: "Let me confirm that.", intent: "confirm_order", nextState: "checkout_confirm",
      extractedItems: [], extractedProduct: null, extractedQuantity: null, extractedAddress: null, confidence: 0.95,
    });

    let before = sendsToChat().length;
    await send("shop");
    await world.waitFor(() => sendsToChat().length > before, 15000, "shop handoff");

    before = sendsToChat().length;
    await send("one jollof rice for j479");
    await world.waitFor(() => sendsToChat().length > before, 15000, "add-to-cart reply");

    before = sendsToChat().length;
    await send("confirm it for j479");
    await world.waitFor(() => sendsToChat().length > before, 15000, "confirm reply");

    // Choose DELIVERY (not pickup) — this is the step that used to silently drop the location-request send.
    before = sendsToChat().length;
    await send("2");
    await world.waitFor(() => sendsToChat().length > before, 15000, "delivery prompt");
    assertIncludes(String(sendsToChat().at(-1)?.body?.text ?? ""), "tap the button below to share your location", "prompt text asks for the location");

    // The REAL regression check: a location-request reply keyboard must actually have been sent to THIS chat —
    // not just the prompt text above it. Mutation-testable: reverting to the WA-only call makes this never arrive.
    await world.waitFor(
      () => sendsToChat().some((c: any) => c.body?.reply_markup?.keyboard?.[0]?.[0]?.request_location === true),
      15000,
      "a request_location reply keyboard reaches the chat",
    );
    const locMsg = sendsToChat().find((c: any) => c.body?.reply_markup?.keyboard?.[0]?.[0]?.request_location === true);
    assert(!!locMsg, "location-request keyboard message found");

    // The free-text address path must still work too (never regress the fallback the screenshot's order relied on).
    // Two messages follow (order summary, then the order-action card as a separate send) — check among all of
    // them, not just the last, same lesson as J477/J478's earlier assertion fixes this session.
    before = sendsToChat().length;
    await send("University of Lagos, Akoka, Lagos");
    await world.waitFor(() => sendsToChat().length > before, 15000, "order summary after typed address");
    const newTexts = sendsToChat().slice(before).map((c: any) => String(c.body?.text ?? ""));
    assert(newTexts.some((t) => t.includes("University of Lagos")), `typed address still accepted and used (got: ${newTexts.join(" | ").slice(0, 300)})`);

    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.customerId, sessionKey));
    assert(!!order, "a real order was created for the telegram chat");
  },
};
