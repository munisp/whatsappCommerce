// === W52 SHARE ===
/**
 * J535 — USSD forward text: dialing into the shop use case with an active
 * promo + a public WA phone APPENDS the "Forward: {blurb} {ctwaLink}" line
 * to the W51 promo one-liner (the share-sheet path for USSD users is a
 * plain-text forward).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J535",
  name: "USSD promo line appends the forward text",
  feature: "W52 share: USSD forward line",
  async run(world: World) {
    const before = await world.tenantSettings();
    try {
      await world.patchTenantSettings({
        promos: [{ code: "USSDSHARE", type: "percent", value: 5 }],
        whatsapp: { ...(before as any)?.whatsapp, displayPhone: "2349000000535" },
      });
      const phone = world.newPhone("6");
      const sid = `ussd-j535-${Date.now()}`;
      await world.ussd(sid, phone, ""); // open the menu
      const shop = await world.ussd(sid, phone, "1"); // first entry = shop
      assert(shop.includes("Forward:"), `forward line present (got ${shop.slice(0, 200)})`);
      assert(shop.includes("https://wa.me/2349000000535?text="), `forward carries the ctwa link (got ${shop.slice(0, 300)})`);
      const link = /https:\/\/wa\.me\/2349000000535\?text=\S+/.exec(shop)?.[0] ?? "";
      assert(decodeURIComponent(link).includes("DEAL USSDSHARE"), `prefilled grammar in the link (got ${link})`);
      assert(shop.includes("DEAL:") && shop.includes("USSDSHARE"), "W51 promo one-liner still present");
      assert(shop.indexOf("DEAL:") < shop.indexOf("Forward:"), "promo line appends the forward text");
    } finally {
      await world.patchTenantSettings({
        promos: (before as any)?.promos ?? [],
        whatsapp: (before as any)?.whatsapp ?? {},
      });
    }
  },
};
