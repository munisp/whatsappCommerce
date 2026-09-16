/**
 * === W38 stock integrity (Coder C, ORD-5) ===
 * J262 — Wholesale oversell guard. placeWholesaleOrderTx previously did ZERO
 * stock reads: any quantity could be ordered against any listing. Now:
 *   1. Listing linked to a seller catalog product with insufficient stock →
 *      refused with insufficient_stock (no order row, no credit draw).
 *   2. Sufficient stock → order placed, fulfillment_untracked = false.
 *   3. Listing with NO catalog product link → order placed but honestly
 *      flagged fulfillment_untracked = true (never a silent oversell).
 */
import { eq } from "drizzle-orm";
import { SUPPLIER_PRODUCTS, SUPPLIER_TENANT_ID, TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J262",
  name: "wholesale oversell rejected + untracked flag",
  feature: "ORD-5 stock guard in placeWholesaleOrderTx",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { placeWholesaleOrderTx } = await import("../../server/services/wholesaleCatalog");

    const cratesId = SUPPLIER_PRODUCTS.crates.id; // stock 5_000 in world seed
    await world.db.update(schema.products).set({ stockQuantity: 100 }).where(eq(schema.products.id, cratesId));

    // Listing linked to the seller's catalog product (stock-tracked).
    const trackedListingId = "1a262000-0000-4000-8000-000000000001";
    await world.db.insert(schema.wholesaleListings).values({
      id: trackedListingId,
      tenantId: SUPPLIER_TENANT_ID,
      productId: cratesId,
      title: "W38 Crates Bulk",
      moq: 1,
      currency: "NGN",
      status: "active",
    });
    await world.db.insert(schema.wholesaleListingTiers).values({
      tenantId: SUPPLIER_TENANT_ID,
      listingId: trackedListingId,
      minQty: 1,
      maxQty: null,
      unitPriceCents: 250_000,
    });

    // 1. Oversell attempt → refused, NO order row persisted.
    const big = await placeWholesaleOrderTx(world.db, {
      listingId: trackedListingId,
      quantity: 500, // > 100 in stock
      buyerTenantId: TENANT_ID,
      paymentMode: "pay_now",
      idempotencyKey: "1a262000-0000-4000-8000-000000000011",
    });
    assert(big.ok === false && big.reason === "insufficient_stock",
      `oversell rejected with insufficient_stock (got ${big.ok ? "ok" : big.reason})`);
    const leaked = await world.db.select().from(schema.wholesaleOrders)
      .where(eq(schema.wholesaleOrders.id, "1a262000-0000-4000-8000-000000000011"));
    assert(leaked.length === 0, "no order row persisted for the rejected oversell");

    // 2. Within stock → placed, tracked.
    const ok = await placeWholesaleOrderTx(world.db, {
      listingId: trackedListingId,
      quantity: 40,
      buyerTenantId: TENANT_ID,
      paymentMode: "pay_now",
      idempotencyKey: "1a262000-0000-4000-8000-000000000012",
    });
    assert(ok.ok === true, `in-stock order placed (got ${ok.ok ? "ok" : ok.reason})`);
    if (ok.ok) {
      assert(ok.order.fulfillmentUntracked === false, "tracked listing → fulfillment_untracked false");
    }

    // 3. Unlinked listing → placed but honestly flagged untracked.
    const untrackedListingId = "1a262000-0000-4000-8000-000000000002";
    await world.db.insert(schema.wholesaleListings).values({
      id: untrackedListingId,
      tenantId: SUPPLIER_TENANT_ID,
      productId: null,
      title: "W38 Unlinked Bulk",
      moq: 1,
      currency: "NGN",
      status: "active",
    });
    await world.db.insert(schema.wholesaleListingTiers).values({
      tenantId: SUPPLIER_TENANT_ID,
      listingId: untrackedListingId,
      minQty: 1,
      maxQty: null,
      unitPriceCents: 100_000,
    });
    const untracked = await placeWholesaleOrderTx(world.db, {
      listingId: untrackedListingId,
      quantity: 10,
      buyerTenantId: TENANT_ID,
      paymentMode: "pay_now",
      idempotencyKey: "1a262000-0000-4000-8000-000000000013",
    });
    assert(untracked.ok === true, `unlinked listing order placed (got ${untracked.ok ? "ok" : untracked.reason})`);
    if (untracked.ok) {
      assert(untracked.order.fulfillmentUntracked === true,
        "ORD-5: unlinked listing is explicitly flagged fulfillment_untracked — never silent");
    }
  },
};
