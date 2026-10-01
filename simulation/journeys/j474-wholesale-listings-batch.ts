// === W48 api-db ===
/**
 * J474 — PERF-API-8: wholesale listMyListings N+1 → ONE inArray tiers query
 * grouped in JS.
 *
 * Seeds 3 listings with 2 tiers each (+ a foreign-tenant listing that must
 * not leak) and proves the tRPC query returns listings with correctly
 * grouped tiers.
 */
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J474",
  name: "wholesale listMyListings batched tiers (PERF-API-8)",
  feature: "one inArray wholesale_listing_tiers query grouped per listing",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const listingIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const lid = randomUUID();
      listingIds.push(lid);
      await world.db.insert(schema.wholesaleListings).values({
        id: lid, tenantId: TENANT_ID, title: `J474 Listing ${i}`,
        moq: 1, currency: "NGN", status: "active",
      });
      for (let tI = 0; tI < 2; tI++) {
        await world.db.insert(schema.wholesaleListingTiers).values({
          id: randomUUID(), tenantId: TENANT_ID, listingId: lid,
          minQty: 1 + tI * 10, maxQty: tI === 0 ? 9 : null,
          unitPriceCents: 1000 + i * 100 + tI,
        });
      }
    }
    // Foreign tenant listing — must never appear.
    await world.db.insert(schema.wholesaleListings).values({
      id: randomUUID(), tenantId: "sim-other-tenant", title: "foreign", moq: 1, currency: "NGN", status: "active",
    });

    const caller = await tenantCaller(TENANT_ID);
    const out = await caller.wholesale.listMyListings({ tenantId: TENANT_ID, limit: 50 });
    const mine = out.filter((r: any) => listingIds.includes(r.listing.id));
    assert(mine.length === 3, `3 listings returned (got ${mine.length})`);
    for (const r of mine) {
      assert(Array.isArray(r.tiers) && r.tiers.length === 2, `listing ${r.listing.title} has its 2 tiers grouped`);
      assert(r.tiers.every((t: any) => t.listingId === r.listing.id), "tiers grouped under the right listing");
    }
    assert(out.every((r: any) => r.listing.tenantId === TENANT_ID), "no cross-tenant leakage");
  },
};
