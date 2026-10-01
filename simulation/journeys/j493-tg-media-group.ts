// === W49 RICHMEDIA ===
/**
 * J493 — RICH-5: Telegram sendMediaGroup albums for browse results.
 *
 *   1. sendTelegramMediaGroup reaches the Bot API with 2..10 photo items,
 *      captions on each item.
 *   2. sendTelegramBrowseAlbum absolutizes relative image URLs and skips
 *      imageless items; <2 usable images → false (text fallback).
 *   3. Bounds: 1 or 11 items throw honestly.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J493",
  name: "TG sendMediaGroup album for browse results",
  feature: "RICH-5",
  async run(world: World) {
    await ensureTelegramConfig(world);
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { sendTelegramMediaGroup } = await import("../../server/services/telegramSender");
    const { sendTelegramBrowseAlbum } = await import("../../server/services/richMedia");

    // Bounds.
    for (const n of [1, 11]) {
      let threw = false;
      try {
        await sendTelegramMediaGroup(TENANT_ID, "493001",
          Array.from({ length: n }, (_, i) => ({ type: "photo" as const, media: `https://cdn.example.com/${i}.jpg` })));
      } catch { threw = true; }
      assert(threw, `media group with ${n} items throws (2..10 bound)`);
    }

    // Browse album with mixed absolute/relative/missing images.
    tg.reset();
    const sent = await sendTelegramBrowseAlbum(TENANT_ID, "493001", [
      { id: "p1", name: "Ankara", priceText: "₦4,500", imageUrl: "/api/storage/product-images/a.jpg" },
      { id: "p2", name: "Gele", priceText: "₦2,000", imageUrl: "https://cdn.example.com/g.jpg" },
      { id: "p3", name: "No-Image Thing", priceText: "₦500", imageUrl: null },
    ]);
    assert(sent === true, "album sent");
    const group = tg.callsFor("sendMediaGroup").pop();
    assert(group, "sendMediaGroup captured");
    assert(group!.body.media.length === 2, "imageless item skipped");
    assert(group!.body.media[0].media === "https://shop.example.com/api/storage/product-images/a.jpg", "relative url absolutized");
    assert(String(group!.body.media[1].caption).includes("Gele"), "caption carries name/price");

    // Fewer than 2 usable images → false (caller falls back to text list).
    const single = await sendTelegramBrowseAlbum(TENANT_ID, "493001", [
      { id: "p1", name: "A", priceText: "₦1", imageUrl: "/api/storage/product-images/a.jpg" },
      { id: "p2", name: "B", priceText: "₦2", imageUrl: null },
    ]);
    assert(single === false, "<2 usable images → fallback");
  },
};
