// === W51 PROMOS ===
/**
 * J526 — USSD promo one-liner parity: dialing into the shop use case with an
 * active promo prepends the localized "DEAL: … Use code X" line to the USSD
 * reply. USSD "popular" also returns the numbered popular-items list.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J526",
  name: "USSD promo one-liner on shop entry + popular items list",
  feature: "W51 promos: USSD parity",
  async run(world: World) {
    const before = await world.tenantSettings();
    try {
      await world.patchTenantSettings({
        promos: [{ code: "USSD5", type: "percent", value: 5 }],
      });
      const phone = world.newPhone("6");
      const sid = `ussd-j526-${Date.now()}`;
      await world.ussd(sid, phone, ""); // open the menu
      const shop = await world.ussd(sid, phone, "1"); // first entry = shop
      assert(shop.includes("DEAL:") && shop.includes("USSD5"),
        `promo one-liner on the shop path (got ${shop.slice(0, 160)})`);

      const pop = await world.ussd(`ussd-j526b-${Date.now()}`, world.newPhone("6"), "popular");
      assert(/most ordered items/i.test(pop), `popular list header (got ${pop.slice(0, 120)})`);
    } finally {
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
    }
  },
};
