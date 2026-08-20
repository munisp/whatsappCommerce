/**
 * J124 — Merchant geo onboarding: geo.merchant.setLocation persists lat/lng
 * plus the computed geohash; the discoverable toggle gates appearance in
 * geo.discover results; the search radius is respected (a customer 3 km away
 * sees the merchant with radius 5, a customer 30 km away does not).
 */
import {
  assert,
  TENANT_ID,
  type World,
} from "../world";
import type { Journey } from "../runner";
import { publicCaller, resetGeoDiscovery, tenantCaller } from "./helpers";

const SHOP = { lat: 6.5244, lng: 3.3792 };
const NEAR_CUSTOMER = { lat: 6.5514, lng: 3.3792 }; // ~3.0 km north
const FAR_CUSTOMER = { lat: 6.7944, lng: 3.3792 }; // ~30 km north

export const journey: Journey = {
  id: "J124",
  name: "merchant geo onboarding",
  feature: "geo.merchant.setLocation/setDiscoverable",
  async run(world: World) {
    await resetGeoDiscovery(world);
    const { encodeGeohash } = await import("../../server/services/geoDiscovery");

    const merchant = await tenantCaller(TENANT_ID);
    const pub = await publicCaller();

    // setLocation persists coordinates + derived geohash; discovery is OFF
    // by default.
    const created = await merchant.geo.merchant.setLocation({
      label: "Sim Store HQ",
      latitude: SHOP.lat,
      longitude: SHOP.lng,
      addressLine: "1 Sim Way",
      city: "Lagos",
      country: "Nigeria",
      serviceRadiusKm: 5,
    });
    const expectedHash = encodeGeohash(SHOP.lat, SHOP.lng);
    assert(created.geohash === expectedHash, `geohash ${created.geohash} === ${expectedHash}`);
    assert(created.updated === false, "first setLocation inserts");

    const saved = await merchant.geo.merchant.getLocation();
    assert(saved, "getLocation returns the persisted row");
    assert(Math.abs(Number(saved.latitude) - SHOP.lat) < 1e-6, `latitude persisted (${saved.latitude})`);
    assert(Math.abs(Number(saved.longitude) - SHOP.lng) < 1e-6, `longitude persisted (${saved.longitude})`);
    assert(saved.geohash === expectedHash, "persisted geohash matches");
    assert(saved.discoverable === false, "discoverable defaults to false");

    // Not discoverable yet → invisible even to a nearby customer.
    let res = await pub.geo.discover({ lat: NEAR_CUSTOMER.lat, lng: NEAR_CUSTOMER.lng });
    assert(
      !res.items.some((i: any) => i.tenantId === TENANT_ID),
      "non-discoverable merchant hidden at 3 km",
    );

    // Toggle on → nearby customer sees the merchant inside the 5 km radius.
    await merchant.geo.merchant.setDiscoverable({ discoverable: true });
    res = await pub.geo.discover({ lat: NEAR_CUSTOMER.lat, lng: NEAR_CUSTOMER.lng });
    const hit = res.items.find((i: any) => i.tenantId === TENANT_ID);
    assert(hit, "discoverable merchant visible at 3 km (radius 5)");
    assert(hit.distanceKm > 2.5 && hit.distanceKm < 3.5, `distance ≈3 km (got ${hit.distanceKm})`);
    assert(res.radiusKm === 5, "default 5 km radius applied");

    // Radius respected: a customer 30 km away does NOT see the merchant.
    res = await pub.geo.discover({ lat: FAR_CUSTOMER.lat, lng: FAR_CUSTOMER.lng });
    assert(
      !res.items.some((i: any) => i.tenantId === TENANT_ID),
      "merchant hidden from a 30 km-away customer at radius 5",
    );

    // Toggle back off → hidden again.
    await merchant.geo.merchant.setDiscoverable({ discoverable: false });
    res = await pub.geo.discover({ lat: NEAR_CUSTOMER.lat, lng: NEAR_CUSTOMER.lng });
    assert(
      !res.items.some((i: any) => i.tenantId === TENANT_ID),
      "toggling discovery off hides the merchant again",
    );
  },
};
