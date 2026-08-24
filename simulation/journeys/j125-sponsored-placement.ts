/**
 * J125 — Sponsored placement: a merchant creates a location-aware sponsored
 * listing centered on its shop; a customer inside the listing radius sees
 * the merchant boosted and flagged with the "★ Sponsored" disclosure label
 * (sponsored entries capped per page); a customer outside the listing radius
 * gets no boost; pausing the listing removes the boost.
 */
import {
  assert,
  assertIncludes,
  bodyText,
  SUPPLIER_TENANT_ID,
  TENANT_ID,
  type World,
} from "../world";
import type { Journey } from "../runner";
import { approveKyb, publicCaller, resetGeoDiscovery, tenantCaller } from "./helpers";

const SHOP = { lat: 6.5244, lng: 3.3792 }; // Sim Store — sponsored, big bid
const LOC_B = { lat: 6.5255, lng: 3.3792 }; // Geo Boost B — sponsored, mid bid
const LOC_C = { lat: 6.5228, lng: 3.3792 }; // Geo Boost C — sponsored, low bid (capped out)
const ORGANIC = { lat: 6.5272, lng: 3.3792 }; // supplier — organic, closest
const CUSTOMER = { lat: 6.53, lng: 3.3792 }; // ~0.3–0.8 km from all four
const FAR_CUSTOMER = { lat: 6.7944, lng: 3.3792 }; // ~30 km — outside listing radii

const TENANT_B = "sim-geo-b";
const TENANT_C = "sim-geo-c";

function sponsoredCount(menu: string): number {
  return (menu.match(/★ Sponsored:/g) ?? []).length;
}

export const journey: Journey = {
  id: "J125",
  name: "sponsored placement boost",
  feature: "geo sponsored listings: boost + cap + pause",
  async run(world: World) {
    await resetGeoDiscovery(world);
    const schema = await import("../../drizzle/schema");

    // Two extra merchants so three sponsored listings exceed the per-page
    // sponsored cap (GEO_SPONSORED_MAX_PER_PAGE default 2).
    for (const [id, name] of [[TENANT_B, "Geo Boost B"], [TENANT_C, "Geo Boost C"]] as const) {
      await world.db.insert(schema.tenants).values({
        id,
        name,
        slug: id,
        plan: "growth",
        status: "active",
        defaultCurrency: "NGN",
        defaultLanguage: "en",
        settings: {},
      }).onConflictDoNothing();
    }

    // All four merchants publish locations (wide service radius so the far
    // customer can still see them organically) and opt in to discovery.
    const locs: Array<[string, { lat: number; lng: number }]> = [
      [TENANT_ID, SHOP],
      [SUPPLIER_TENANT_ID, ORGANIC],
      [TENANT_B, LOC_B],
      [TENANT_C, LOC_C],
    ];
    for (const [tid, loc] of locs) {
      // W30: discovery is KYB fail-closed — approve before publishing.
      await approveKyb(world, tid);
      const caller = await tenantCaller(tid);
      await caller.geo.merchant.setLocation({
        latitude: loc.lat,
        longitude: loc.lng,
        serviceRadiusKm: 50,
      });
      await caller.geo.merchant.setDiscoverable({ discoverable: true });
    }

    // Sponsored listings for three of the four merchants (supplier stays
    // organic). Biggest bid on the Sim Store.
    const merchant = await tenantCaller(TENANT_ID);
    const listing = await merchant.geo.merchant.createSponsoredListing({
      name: "Sim Store weekend boost",
      centerLat: SHOP.lat,
      centerLng: SHOP.lng,
      radiusKm: 10,
      bidCents: 500,
      dailyBudgetCents: 10_000,
    });
    assert(listing.status === "active", "listing goes live immediately");
    const callerB = await tenantCaller(TENANT_B);
    await callerB.geo.merchant.createSponsoredListing({
      name: "B boost", centerLat: LOC_B.lat, centerLng: LOC_B.lng,
      radiusKm: 10, bidCents: 300, dailyBudgetCents: 10_000,
    });
    const callerC = await tenantCaller(TENANT_C);
    await callerC.geo.merchant.createSponsoredListing({
      name: "C boost", centerLat: LOC_C.lat, centerLng: LOC_C.lng,
      radiusKm: 10, bidCents: 200, dailyBudgetCents: 10_000,
    });

    // Customer inside the listing radius: pin → menu with sponsored first.
    const phone = world.newPhone("geo");
    await world.grantConsent(phone);
    await world.location(phone, CUSTOMER.lat, CUSTOMER.lng);
    let menu = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(menu, "★ Sponsored: Sim Store", "top-bid merchant flagged sponsored in the menu");
    assert(
      sponsoredCount(menu) === 2,
      `sponsored entries capped at 2 per page (got ${sponsoredCount(menu)}): ${menu.slice(0, 300)}`,
    );
    assert(
      !menu.includes("Geo Boost C"),
      "third sponsored listing demoted by the per-page cap",
    );
    assertIncludes(menu, "Lagos Plastics", "closest organic merchant still listed");

    // Customer OUTSIDE the listing radius (radius 50 search, listings reach
    // 10 km): merchants visible but nothing flagged sponsored.
    const pub = await publicCaller();
    const far = await pub.geo.discover({ lat: FAR_CUSTOMER.lat, lng: FAR_CUSTOMER.lng, radiusKm: 50 });
    assert(far.items.length >= 3, `far customer sees merchants organically (got ${far.items.length})`);
    assert(
      far.items.every((i: any) => !i.sponsored),
      "no sponsored boost outside the listing radius",
    );

    // Pause the Sim Store listing → its boost disappears from the menu.
    const paused = await merchant.geo.merchant.pauseSponsoredListing({ id: listing.id });
    assert(paused.status === "paused", "listing paused");
    await world.location(phone, CUSTOMER.lat, CUSTOMER.lng);
    menu = bodyText(world.outbound.lastOfType("text", phone));
    assert(
      !menu.includes("★ Sponsored: Sim Store"),
      `paused listing loses the sponsored label (got: ${menu.slice(0, 300)})`,
    );
    assertIncludes(menu, "Sim Store", "paused merchant still appears organically");
    assert(
      sponsoredCount(menu) === 2 &&
        menu.includes("★ Sponsored: Geo Boost B") &&
        menu.includes("★ Sponsored: Geo Boost C"),
      `the two still-active listings take the sponsored slots (got ${sponsoredCount(menu)}): ${menu.slice(0, 300)}`,
    );

    // Tidy up the extra tenants (their geo rows are wiped by resetGeoDiscovery).
    const { inArray } = await import("drizzle-orm");
    await world.db.delete(schema.tenants)
      .where(inArray(schema.tenants.id, [TENANT_B, TENANT_C])).catch(() => {});
  },
};
