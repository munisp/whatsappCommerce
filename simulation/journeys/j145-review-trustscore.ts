/**
 * J145 — Review → trustScore effect on geoDiscovery: with no reviews the
 * merchant's discovery trustScore is null/unknown; after purchase-verified
 * 5★ reviews the review-driven trust provider (registered into
 * geoDiscovery's additive hook) lifts the merchant's ranking score
 * deterministically; removing the reviews drops it back.
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, resetGeoDiscovery, tenantCaller } from "./helpers";

const SHOP = { lat: 6.5244, lng: 3.3792 };
const CUSTOMER = { lat: 6.53, lng: 3.3792 }; // ~0.6 km north

export const journey: Journey = {
  id: "J145",
  name: "review → trustScore effect on discovery ranking",
  feature: "review-driven trustScore via geoDiscovery hook",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { discoverNearby } = await import("../../server/services/geoDiscovery");
    const { createReview, registerReviewTrustScoreProvider, computeReviewTrustScorePure } =
      await import("../../server/services/reviews");
    registerReviewTrustScoreProvider();

    // Journey isolation: clear any reviews left by earlier journeys (J144).
    await world.db.delete(schema.reviews).catch(() => {});
    await resetGeoDiscovery(world);
    const tenant = await tenantCaller(TENANT_ID);
    await tenant.geo.merchant.setLocation({
      label: "Sim Store HQ",
      latitude: SHOP.lat,
      longitude: SHOP.lng,
      addressLine: "1 Sim Way",
      city: "Lagos",
      country: "Nigeria",
    });
    await tenant.geo.merchant.setDiscoverable({ discoverable: true });
    await approveKyb(world, TENANT_ID);

    // ── 1. No reviews → trustScore null (unknown) ───────────────────────
    const before = await discoverNearby({ lat: CUSTOMER.lat, lng: CUSTOMER.lng, radiusKm: 5 }, world.db as any);
    const itemBefore = before.items.find((i) => i.tenantId === TENANT_ID);
    assert(itemBefore, "merchant discoverable before reviews");
    assert(itemBefore!.trustScore == null, `trustScore unknown before reviews (got ${itemBefore!.trustScore})`);
    const scoreBefore = itemBefore!.score;

    // ── 2. Two verified 5★ reviews → trustScore lifts the ranking ───────
    // Purchase proof: delivered orders for two distinct buyers.
    for (const [n, phone] of ["2348077000001", "2348077000002"].entries()) {
      const orderId = crypto.randomUUID();
      await world.db.insert(schema.orders).values({
        id: orderId,
        tenantId: TENANT_ID,
        customerId: phone as string,
        orderNumber: `ORD-J145-${n}`,
        status: "delivered",
        totalAmount: "2500.00",
        currency: "NGN",
        paymentStatus: "completed",
      });
      const review = await createReview(world.db as any, {
        tenantId: TENANT_ID,
        customerPhone: phone as string,
        rating: 5,
        text: "Excellent!",
        orderId,
      });
      assert(review.status === "published", "verified review created");
    }

    const expected = computeReviewTrustScorePure({ avgRating: 5, publishedCount: 2, removedCount: 0 });
    assert(expected === 82, `deterministic score formula (got ${expected})`);

    const after = await discoverNearby({ lat: CUSTOMER.lat, lng: CUSTOMER.lng, radiusKm: 5 }, world.db as any);
    const itemAfter = after.items.find((i) => i.tenantId === TENANT_ID);
    assert(itemAfter, "merchant still discoverable after reviews");
    assert(itemAfter!.trustScore === expected,
      `discovery trustScore comes from reviews (${itemAfter!.trustScore} != ${expected})`);
    assert(itemAfter!.score > scoreBefore,
      `ranking score lifted by reviews (${scoreBefore} → ${itemAfter!.score})`);

    // ── 3. Moderating the reviews away removes the trust signal ─────────
    const list = await tenant.reviews.list({ tenantId: TENANT_ID });
    for (const r of list) {
      await tenant.reviews.moderate({ tenantId: TENANT_ID, reviewId: r.id, status: "removed" });
    }
    const removed = await discoverNearby({ lat: CUSTOMER.lat, lng: CUSTOMER.lng, radiusKm: 5 }, world.db as any);
    const itemRemoved = removed.items.find((i) => i.tenantId === TENANT_ID);
    assert(itemRemoved!.trustScore == null || itemRemoved!.score <= scoreBefore + 1,
      "removed reviews withdraw the trust boost");
  },
};
