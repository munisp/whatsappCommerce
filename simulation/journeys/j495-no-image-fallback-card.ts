// === W49 RICHMEDIA ===
/**
 * J495 — RICH-12: a product WITHOUT an image still gets the uniform card
 * layout (text header + same buttons) on both channels instead of silently
 * losing all visual structure; a fallback brand image is used when offered.
 *
 *   WA: interactive with TEXT header (no broken image) + cart buttons.
 *   TG: keyboard message (no sendPhoto) with the same buttons.
 *   With fallbackImageUrl: WA card header is the fallback image.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J495",
  name: "no-image products still send the uniform card layout (WA + TG)",
  feature: "RICH-12",
  async run(world: World) {
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { sendWhatsAppProductCard, sendTelegramProductCard } = await import("../../server/services/richMedia");
    const phone = "+2348017000495";

    // WA: no image → text header card, same buttons.
    await sendWhatsAppProductCard(TENANT_ID, phone, { productId: "prod-495", name: "Plain Wrapper", priceText: "₦1,200" });
    let ia = (world.outbound.lastOfType("interactive", phone.replace("+", ""))!.body as any).interactive;
    assert(ia.header?.type === "text", "text header fallback (no broken image)");
    assert(ia.header.text === "Plain Wrapper", "header carries the name");
    assert(ia.action.buttons.length === 2, "same action buttons");

    // WA: fallback brand image is used.
    await sendWhatsAppProductCard(TENANT_ID, phone, {
      productId: "prod-495",
      name: "Plain Wrapper",
      priceText: "₦1,200",
      fallbackImageUrl: "/api/storage/tenant-branding/sim-tenant/card.png",
    });
    ia = (world.outbound.lastOfType("interactive", phone.replace("+", ""))!.body as any).interactive;
    assert(ia.header?.type === "image", "fallback image used");
    assert(ia.header.image.link === "https://shop.example.com/api/storage/tenant-branding/sim-tenant/card.png", "fallback absolutized");

    // TG: no image → keyboard message with the same buttons, no photo.
    await ensureTelegramConfig(world);
    tg.reset();
    await sendTelegramProductCard(TENANT_ID, "495001", { productId: "prod-495", name: "Plain Wrapper", priceText: "₦1,200" });
    assert(tg.callsFor("sendPhoto").length === 0, "no TG photo without an image");
    const msg = tg.callsFor("sendMessage").pop();
    assert(msg?.body?.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === "buy_now:prod-495"), "TG uniform card buttons");
  },
};
