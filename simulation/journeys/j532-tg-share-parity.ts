// === W52 SHARE ===
/**
 * J532 — Telegram share parity: the TG promo keyboard carries the 📤 Share
 * button, and buildDealShareBundle produces the t.me/share/url deep link
 * whose url= is the merchant ctwa link and text= is the localized blurb.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J532",
  name: "TG share URL parity + promo keyboard share button",
  feature: "W52 share: Telegram parity",
  async run(world: World) {
    const before = await world.tenantSettings();
    await ensureTelegramConfig(world);
    try {
      await world.patchTenantSettings({
        whatsapp: { ...(before as any)?.whatsapp, displayPhone: "2349000000532" },
      });

      // 1. Bundle builder: TG share URL shape.
      const { buildDealShareBundle } = await import("../../server/services/shareDeal");
      const promo = { kind: "promo" as const, title: "Promo SHARE32", discountText: "30% off", code: "SHARE32" };
      const bundle = buildDealShareBundle({
        settings: { whatsapp: { displayPhone: "2349000000532" } },
        promo, referralCode: "REF-TG32AA", locale: "en",
      });
      assert(bundle, "bundle built");
      assert(bundle!.ctwaLink.startsWith("https://wa.me/2349000000532?text="), `ctwa link (got ${bundle!.ctwaLink})`);
      assert(decodeURIComponent(bundle!.ctwaLink).includes("DEAL SHARE32 REF REF-TG32AA"), "prefilled grammar");
      const tgUrl = bundle!.tgShareUrl;
      assert(tgUrl.startsWith("https://t.me/share/url?url="), `t.me share URL (got ${tgUrl})`);
      const parsed = new URL(tgUrl);
      assert(parsed.searchParams.get("url") === bundle!.ctwaLink, "url= is the ctwa link");
      assert(parsed.searchParams.get("text") === bundle!.blurb, "text= is the blurb");
      assert(bundle!.waShareUrl.startsWith("https://wa.me/?text="), "WA share URL");
      assert(bundle!.forwardText.startsWith("Forward:"), `forward text (got ${bundle!.forwardText})`);

      // 2. TG promo keyboard carries the share button.
      const { deliverTelegramRichAnnotations } = await import("../../server/services/telegramInbound");
      tg.reset();
      await deliverTelegramRichAnnotations("sim-tenant", "532001", {
        promoCard: { ...promo, imageUrl: null }, language: "english",
      });
      const msg = tg.callsFor("sendMessage").pop();
      assert(msg, "TG promo keyboard message sent");
      const kb = msg!.body.reply_markup?.inline_keyboard?.flat() ?? [];
      assert(kb.some((b: any) => b.callback_data === "promo_share:SHARE32"),
        `share button on the TG keyboard (got ${JSON.stringify(kb.map((b: any) => b.callback_data))})`);
      assert(kb.some((b: any) => b.callback_data === "promo_deal:SHARE32"), "View deal button kept");
    } finally {
      await world.patchTenantSettings({ whatsapp: (before as any)?.whatsapp ?? {} });
    }
  },
};
