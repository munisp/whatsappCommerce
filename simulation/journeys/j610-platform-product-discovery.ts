/**
 * J610 — platform product discovery (W50 phase 3).
 *
 * On the shared platform number, typing a PRODUCT (not a shop name) finds the
 * nearest shops that stock it:
 *   - product query with no known location → asked to share 📎 location
 *     (the query is remembered)
 *   - share location                       → nearest shops stocking it, only
 *     SHARED shops (reachable here)
 *   - repeat query                          → uses the saved location, no re-ask
 * Reuses the W25 geo engine (loadDiscoveryData + discoverNearbyPure). Gated by
 * WHATSAPP_PLATFORM_NUMBER_ID (set here for the journey only).
 */
import { eq } from "drizzle-orm";
import { assert, bodyText, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";
import { resetGeoDiscovery, seedDiscoverableMerchant } from "./helpers";

const PLATFORM_PN = "pn_sim_platform_001";
const PLATFORM_TOKEN = "sim-platform-token";
const SHOP = { lat: 6.5244, lng: 3.3792 }; // Lagos
const CUSTOMER = { lat: 6.525, lng: 3.3795 }; // ~0.1 km from the shop

export const journey: Journey = {
  id: "J610",
  name: "platform product discovery",
  feature: "W50: type a product on the platform number → nearest shops that stock it",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const onboarding = await import("../../server/services/onboarding");
    const lc = await import("../../server/services/onboardingLifecycle");
    const pn = await import("../../server/services/platformNumber");

    process.env.WHATSAPP_PLATFORM_NUMBER_ID = PLATFORM_PN;
    process.env.WHATSAPP_PLATFORM_TOKEN = PLATFORM_TOKEN;
    pn.__clearActiveShopMemory();
    await resetGeoDiscovery(world);
    try {
      // A SHARED, live, discoverable shop that stocks Toothpaste; own number NULL.
      const { tenantId } = await onboarding.createTenant({ name: "Fresh Mart", businessType: "retail" });
      await onboarding.setOnboardingStatus(tenantId, "validating", { validationPassed: true });
      await seedDiscoverableMerchant(world, tenantId, {
        lat: SHOP.lat, lng: SHOP.lng, category: "groceries", productName: "Toothpaste",
      });
      await lc.goLiveTenant(tenantId, { actorId: "1", actorRole: "admin", source: "j610" });
      const [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
      assert(row.status === "active" && row.whatsappPhoneNumberId == null, "Fresh Mart is a shared, active shop");

      const buyer = world.newPhone("plat-buyer");

      // ── 1. Product query, no known location → asked to share location ─────
      await world.inbound(payloads.inbound.text(PLATFORM_PN, buyer, "toothpaste"));
      await world.settle();
      const ask = world.outbound.lastTo(buyer);
      assert(ask && new URL(ask.url).pathname.includes(PLATFORM_PN), "location ask via the platform number");
      assert(bodyText(ask).toLowerCase().includes("location"), "a no-location product query asks for the location");
      assert((await pn.getPendingQuery(buyer)) === "toothpaste", "pending query remembered");

      // ── 2. Share location → nearest shops stocking it (incl. Fresh Mart) ──
      await world.inbound(payloads.inbound.location(PLATFORM_PN, buyer, CUSTOMER.lat, CUSTOMER.lng, "Home"));
      await world.settle();
      const results = world.outbound.lastTo(buyer);
      assert(results && new URL(results.url).pathname.includes(PLATFORM_PN), "discovery results via the platform number");
      assert(
        bodyText(results).includes("Fresh Mart"),
        `nearest-shops reply lists the shop stocking toothpaste (got: ${bodyText(results).slice(0, 180)})`,
      );
      assert((await pn.getPendingQuery(buyer)) === null, "pending query cleared after it ran");

      // ── 3. Repeat search with the saved location → immediate results ──────
      await world.inbound(payloads.inbound.text(PLATFORM_PN, buyer, "toothpaste"));
      await world.settle();
      assert(bodyText(world.outbound.lastTo(buyer)).includes("Fresh Mart"), "repeat search uses the saved location (no re-ask)");
    } finally {
      delete process.env.WHATSAPP_PLATFORM_NUMBER_ID;
      delete process.env.WHATSAPP_PLATFORM_TOKEN;
      pn.__clearActiveShopMemory();
      await resetGeoDiscovery(world);
    }
  },
};
