/**
 * J130 — W27 catalog-ai: deterministic price suggestion sanity.
 *
 * Covers the full fallback chain (tenant category median → tenant-wide median
 * → platform category median → none), integer-cents invariant, band
 * computation, and createDraft's integration (explicit price wins; otherwise
 * the suggestion is used).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J130",
  name: "price suggestion sanity",
  feature: "median fallbacks, integer cents, draft integration",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { suggestPriceCents, createDraft, medianCents, priceBand } =
      await import("../../server/services/catalogAI");

    // ── Seed tenant products: beverages 100/200/300/400 (median 250) and
    //    one snacks product 999 (used by the tenant-wide fallback). ───────
    const seeds = [
      ["p-j130-b1", "beverages", "100.00"],
      ["p-j130-b2", "beverages", "200.00"],
      ["p-j130-b3", "beverages", "300.00"],
      ["p-j130-b4", "beverages", "400.00"],
      ["p-j130-s1", "j130snacks", "9.99"],
      // Unique category used for the deterministic platform-wide fallback test
      // (an empty tenant falls through to these rows).
      ["p-j130-x1", "j130plat", "500.00"],
      ["p-j130-x2", "j130plat", "700.00"],
    ] as const;
    for (const [id, category, price] of seeds) {
      await world.db.insert(schema.products).values({
        id, tenantId: TENANT_ID, sku: `SIM-J130-${id}`, name: `J130 ${id}`,
        category, price, currency: "NGN", status: "active", stockQuantity: 3,
      }).onConflictDoNothing();
    }
    // Inactive product must be ignored by the stats.
    await world.db.insert(schema.products).values({
      id: "p-j130-dead", tenantId: TENANT_ID, sku: "SIM-J130-dead", name: "dead",
      category: "beverages", price: "1.00", currency: "NGN", status: "archived", stockQuantity: 0,
    }).onConflictDoNothing();

    // 1. Tenant category median: (20000+30000)/2 = 25000 cents, floor-quantile band 200–400.
    const s1 = await suggestPriceCents(world.db, TENANT_ID, "beverages");
    assert(s1.basis === "tenant_category", `category basis (got ${s1.basis})`);
    assert(s1.suggestedPriceCents === 25000, `median 25000 (got ${s1.suggestedPriceCents})`);
    assert(s1.bandLowCents === 20000 && s1.bandHighCents === 40000, `band 20000–40000 (got ${s1.bandLowCents}-${s1.bandHighCents})`);
    assert(Number.isInteger(s1.suggestedPriceCents), "integer cents invariant");

    // 2. Unknown category → tenant-wide median over the tenant's active
    //    products (the shared sim tenant has other seeded products, so assert
    //    the invariant, not a fixed value).
    const s2 = await suggestPriceCents(world.db, TENANT_ID, "no_such_category_j130");
    assert(s2.basis === "tenant_all", `tenant-wide fallback (got ${s2.basis})`);
    assert(s2.suggestedPriceCents != null && Number.isInteger(s2.suggestedPriceCents) && s2.suggestedPriceCents > 0,
      `tenant-wide median is positive integer cents (got ${s2.suggestedPriceCents})`);
    assert(s2.sampleSize >= 5, `tenant-wide sample covers seeded rows (got ${s2.sampleSize})`);

    // 3. Fresh tenant with no products → platform category median over the
    //    unique j130plat category: (50000+70000)/2 = 60000.
    const s3 = await suggestPriceCents(world.db, "j130-empty-tenant", "j130plat");
    assert(s3.basis === "platform_category", `platform fallback (got ${s3.basis})`);
    assert(s3.suggestedPriceCents === 60000, `platform category median (got ${s3.suggestedPriceCents})`);

    // 4. No data anywhere → none.
    const s4 = await suggestPriceCents(world.db, "j130-empty-tenant", "zzz_no_match_anywhere");
    assert(s4.basis === "none" && s4.suggestedPriceCents === null, "none fallback");

    // 5. Pure helpers agree with the service math.
    assert(medianCents([100, 300, 200]) === 200, "medianCents odd");
    assert(priceBand([100, 200, 300, 400])!.low === 200, "priceBand low");

    // 6. Draft integration: explicit price wins; omitted price takes suggestion.
    const merchant = world.newPhone("j130");
    const d1 = await createDraft(world.db, {
      tenantId: TENANT_ID, source: "voice", merchantPhone: merchant,
      listing: { name: "Coke 50cl", description: "pet bottle", category: "beverages", priceCents: 45000 },
    });
    assert(d1.suggestedPriceCents === 45000, "explicit price kept");
    const d2 = await createDraft(world.db, {
      tenantId: TENANT_ID, source: "photo", merchantPhone: merchant,
      listing: { name: "Fanta 50cl", description: "pet bottle", category: "beverages" },
    });
    assert(d2.suggestedPriceCents === 25000, `suggestion fills missing price (got ${d2.suggestedPriceCents})`);
    const [ev] = await world.db.select().from(schema.catalogAiDraftEvents)
      .where(eq(schema.catalogAiDraftEvents.draftId, d2.id)).limit(1);
    assert((ev.detail as any)?.priceBasis === "tenant_category", "draft event records price basis");
  },
};
