// === W49 RICHMEDIA ===
/**
 * J488 — RICH-2: telegramInbound no longer drops rich NLP annotations.
 *
 * Given an nlp.processMessage result with orderCard (incl. paymentUrl),
 * productImage and browseProducts, deliverTelegramRichAnnotations must emit:
 *   1. an order-card keyboard (track/pay/cancel; pay as a URL button);
 *   2. a product photo card (sendPhoto with caption + buttons);
 *   3. a browse media-group album (sendMediaGroup) when ≥2 images exist.
 * And it must never throw on partial data (fail-open per send).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J488",
  name: "telegram inbound mirrors WA rich annotations (order card, product image, browse album)",
  feature: "RICH-2",
  async run(world: World) {
    await ensureTelegramConfig(world);
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { deliverTelegramRichAnnotations } = await import("../../server/services/telegramInbound");
    tg.reset();

    await deliverTelegramRichAnnotations(TENANT_ID, "488001", {
      orderCard: { orderId: "ord-488", orderNumber: "SO-488", paymentUrl: "https://pay.example.com/p/488" },
      productImage: { link: "/api/storage/product-images/gele.jpg", caption: "Gele Headtie — ₦2,000", productId: "prod-488" },
      browseProducts: [
        { id: "p1", name: "Gele", priceText: "₦2,000", imageUrl: "/api/storage/product-images/gele.jpg" },
        { id: "p2", name: "Aso-Oke", priceText: "₦8,000", imageUrl: "/api/storage/product-images/aso.jpg" },
      ],
    });

    // 1. order card keyboard with URL pay button
    const keyboard = tg.callsFor("sendMessage").find((c) => JSON.stringify(c.body).includes("SO-488"));
    assert(keyboard, "order action card keyboard sent on TG");
    const flat = keyboard!.body.reply_markup.inline_keyboard.flat();
    assert(flat.some((b: any) => b.url === "https://pay.example.com/p/488"), "pay rendered as URL button");
    assert(flat.some((b: any) => b.callback_data === "order_track:ord-488"), "track button keeps order_* id grammar");
    assert(flat.some((b: any) => b.callback_data === "order_cancel:ord-488"), "cancel button present");

    // 2. product photo card (relative URL absolutized)
    const photo = tg.callsFor("sendPhoto").pop();
    assert(photo, "product photo card sent on TG (was silently dropped pre-W49)");
    assert(photo!.body.photo === "https://shop.example.com/api/storage/product-images/gele.jpg", "photo link absolutized");

    // 3. browse album
    const group = tg.callsFor("sendMediaGroup").pop();
    assert(group, "browse results sent as a TG album");
    assert(Array.isArray(group!.body.media) && group!.body.media.length === 2, "album has 2 items");

    // 4. fail-open: empty/partial annotations never throw
    await deliverTelegramRichAnnotations(TENANT_ID, "488001", {});
    await deliverTelegramRichAnnotations(TENANT_ID, "488001", { orderCard: { orderId: "ord-x" } });

    // 5. RICH-8 helpers: status card + POD photo push, both channels.
    const { sendWhatsAppOrderStatusCard, sendTelegramOrderStatusCard, sendPodPhoto } = await import("../../server/services/richMedia");
    const phone488 = "+2348017000488";
    await sendWhatsAppOrderStatusCard(TENANT_ID, phone488, {
      orderNumber: "SO-488", orderId: "ord-488", status: "out_for_delivery",
      trackingUrl: "https://track.example.com/t/488",
    });
    const sc = (world.outbound.lastOfType("interactive", "2348017000488")!.body as any).interactive;
    assert(sc.type === "cta_url" && sc.action.parameters.url === "https://track.example.com/t/488", "WA status card with Track cta_url");
    tg.reset();
    await sendTelegramOrderStatusCard(TENANT_ID, "488001", { orderNumber: "SO-488", orderId: "ord-488", status: "shipped" });
    const scTg = tg.callsFor("sendMessage").pop();
    assert(scTg?.body?.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === "order_track:ord-488"), "TG status card keyboard");

    tg.reset();
    const podTg = await sendPodPhoto(TENANT_ID, { telegramChatId: "488001" }, { photoUrl: "/api/storage/whatsapp-media/sim-tenant/pod-1.jpg", orderNumber: "SO-488" });
    assert(podTg === true, "POD photo pushed on TG");
    assert(tg.callsFor("sendPhoto").pop()?.body?.photo === "https://shop.example.com/api/storage/whatsapp-media/sim-tenant/pod-1.jpg", "POD photo absolutized");
    const podWa = await sendPodPhoto(TENANT_ID, { phone: phone488 }, { photoUrl: "https://cdn.example.com/pod.jpg", orderNumber: "SO-488" });
    assert(podWa === true, "POD photo pushed on WA");
  },
};
