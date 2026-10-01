// === W49 RICHMEDIA ===
/**
 * J487 — RICH-1: product card = ONE message with an image header + body +
 * [Add to cart][Buy now] buttons on BOTH channels.
 *
 *   WA: buildInteractivePayload emits interactive.header = {type:"image"}
 *       and the interactive carries 2 reply buttons with the cart_add:/
 *       buy_now: id grammar (metaMock outbound capture).
 *   TG: sendTelegramMedia accepts replyMarkup → ONE sendPhoto with an
 *       inline keyboard (tg.calls capture).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J487",
  name: "product card: WA image-header interactive + TG photo+keyboard in one message",
  feature: "RICH-1",
  async run(world: World) {
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { sendWhatsAppProductCard, sendTelegramProductCard } = await import("../../server/services/richMedia");
    const phone = "+2348017000487";

    // ── WA: one interactive with image header ─────────────────────────────
    await sendWhatsAppProductCard(TENANT_ID, phone, {
      productId: "prod-487",
      name: "Ankara Fabric",
      priceText: "₦4,500",
      imageUrl: "/api/storage/product-images/ankara.jpg",
    });
    const wa = world.outbound.lastOfType("interactive", phone.replace("+", ""));
    assert(wa, "WA interactive product card captured");
    const interactive = (wa!.body as any).interactive;
    assert(interactive.header?.type === "image", "header is an image");
    assert(interactive.header.image.link === "https://shop.example.com/api/storage/product-images/ankara.jpg", "absolute image link");
    const ids = interactive.action.buttons.map((b: any) => b.reply.id);
    assert(ids.includes("cart_add:prod-487") && ids.includes("buy_now:prod-487"), `card buttons present (got ${ids})`);
    assert(JSON.stringify(interactive.body.text).includes("Ankara Fabric"), "body carries the product name");

    // ── TG: one sendPhoto with inline keyboard ────────────────────────────
    await ensureTelegramConfig(world);
    tg.reset();
    await sendTelegramProductCard(TENANT_ID, "487001", {
      productId: "prod-487",
      name: "Ankara Fabric",
      priceText: "₦4,500",
      imageUrl: "https://cdn.example.com/ankara.jpg",
    });
    const photo = tg.callsFor("sendPhoto").pop();
    assert(photo, "TG sendPhoto captured");
    assert(photo!.body.photo === "https://cdn.example.com/ankara.jpg", "TG photo url");
    const markup = photo!.body.reply_markup;
    assert(markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === "cart_add:prod-487"), "TG photo carries the same buttons");
    assert(String(photo!.body.caption).includes("Ankara Fabric"), "TG caption carries the product name");
  },
};
