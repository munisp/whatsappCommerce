// === W51 PROMOS ===
/**
 * J522 — Telegram promo spotlight parity: the same promoCard annotation is
 * delivered by deliverTelegramRichAnnotations as a photo card (image
 * present) or a keyboard message (no image), carrying the localized body
 * and the [Shop now][View deal][Popular items] inline keyboard.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J522",
  name: "TG promo card parity (photo + inline keyboard, no-image fallback)",
  feature: "W51 promos: Telegram promo spotlight",
  async run(world: World) {
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    await ensureTelegramConfig(world);
    const { deliverTelegramRichAnnotations } = await import("../../server/services/telegramInbound");
    const promo = {
      kind: "promo" as const,
      title: "Promo FLASH20",
      discountText: "20% off",
      code: "FLASH20",
      imageUrl: "https://cdn.j522.example.com/deal.jpg",
    };

    // 1. With image → ONE sendPhoto with caption + inline keyboard.
    tg.reset();
    await deliverTelegramRichAnnotations(TENANT_ID, "522001", {
      promoCard: promo, language: "english",
    });
    const photo = tg.callsFor("sendPhoto").pop();
    assert(photo, "TG sendPhoto captured for promo card");
    assert(photo!.body.photo === "https://cdn.j522.example.com/deal.jpg", "TG photo url");
    assert(String(photo!.body.caption).includes("FLASH20"), "caption carries the code");
    assert(String(photo!.body.caption).includes("20% off"), "caption carries the discount");
    const kb = photo!.body.reply_markup?.inline_keyboard?.flat() ?? [];
    assert(kb.some((b: any) => b.callback_data === "promo_shop"), "Shop now button");
    assert(kb.some((b: any) => b.callback_data === "promo_deal:FLASH20"), "View deal button");
    assert(kb.some((b: any) => b.callback_data === "promo_popular"), "Popular items button");

    // 2. No image anywhere → keyboard message fallback (uniform card).
    //    PUBLIC_APP_URL unset → no relative/logo URL can absolutize.
    delete process.env.PUBLIC_APP_URL;
    tg.reset();
    await deliverTelegramRichAnnotations(TENANT_ID, "522001", {
      promoCard: { ...promo, imageUrl: null }, language: "english",
    });
    assert(tg.callsFor("sendPhoto").length === 0, "no photo without an image");
    const msg = tg.callsFor("sendMessage").pop();
    assert(msg, "keyboard message fallback sent");
    assert(String(msg!.body.text).includes("FLASH20"), "fallback body carries the code");
    assert(
      msg!.body.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === "promo_deal:FLASH20"),
      "fallback carries the same buttons",
    );
  },
};
