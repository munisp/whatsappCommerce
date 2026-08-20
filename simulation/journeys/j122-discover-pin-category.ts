/**
 * J122 — Geo discovery via location pin + category filter: a KYB-approved
 * merchant publishes its shop location and turns discovery on; a customer
 * shares a WhatsApp location pin near the shop → numbered discovery menu
 * containing the merchant; replying with a category filters the menu (the
 * merchant still appears); a far-away discoverable merchant never appears.
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
import { approveKyb, resetGeoDiscovery, tenantCaller } from "./helpers";

const SHOP = { lat: 6.5244, lng: 3.3792 }; // Lagos (sim store HQ)
const CUSTOMER = { lat: 6.53, lng: 3.3792 }; // ~0.6 km north of the shop
const FAR = { lat: 6.7944, lng: 3.3792 }; // ~30 km north — outside 5 km radius

async function lastText(world: World, phone: string): Promise<string> {
  return bodyText(world.outbound.lastOfType("text", phone));
}

export const journey: Journey = {
  id: "J122",
  name: "discover via pin + category filter",
  feature: "geo discovery: pin → menu → category",
  async run(world: World) {
    await resetGeoDiscovery(world);

    // Merchant onboarding: publish location + opt in to discovery (both a
    // near merchant and a far-away one), KYB-approved for both.
    const near = await tenantCaller(TENANT_ID);
    await near.geo.merchant.setLocation({
      label: "Sim Store HQ",
      latitude: SHOP.lat,
      longitude: SHOP.lng,
      addressLine: "1 Sim Way",
      city: "Lagos",
      country: "Nigeria",
    });
    await near.geo.merchant.setDiscoverable({ discoverable: true });
    const far = await tenantCaller(SUPPLIER_TENANT_ID);
    await far.geo.merchant.setLocation({
      label: "Plastics depot",
      latitude: FAR.lat,
      longitude: FAR.lng,
    });
    await far.geo.merchant.setDiscoverable({ discoverable: true });
    await approveKyb(world, TENANT_ID);
    await approveKyb(world, SUPPLIER_TENANT_ID);

    // Category taxonomy so a category reply resolves ("Sim" ↔ seed products'
    // category "sim").
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.productTaxonomy).values({
      id: "geo-sim-cat-sim",
      category: "Sim",
      subcategory: "Ready meals",
      brand: "Sim Brand",
      productName: "Sim Item",
      tenantId: TENANT_ID,
    });

    const phone = world.newPhone("geo");
    await world.grantConsent(phone);

    // Customer shares a location pin near the shop → discovery menu.
    await world.location(phone, CUSTOMER.lat, CUSTOMER.lng, "Home", "Lagos");
    const menu = await lastText(world, phone);
    assertIncludes(menu, "Businesses near you", "pin produced a discovery menu");
    assertIncludes(menu, "1. Sim Store", "near merchant is listed first");
    assert(
      !menu.includes(SUPPLIER_TENANT_ID) && !menu.includes("Lagos Plastics"),
      `far-away merchant not in menu (got: ${menu.slice(0, 200)})`,
    );
    assertIncludes(menu, "Reply with a category", "menu invites category filtering");

    // Reply with a category → filtered menu still contains the merchant.
    await world.text(phone, "Sim");
    const filtered = await lastText(world, phone);
    assertIncludes(filtered, "Businesses near you", "category reply produced a filtered menu");
    assertIncludes(filtered, "Sim Store", "merchant survives the category filter");
    assert(
      !filtered.includes("Lagos Plastics"),
      "far merchant still absent after category filter",
    );
  },
};
