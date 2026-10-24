// === W64 intelligence ===
/**
 * J617 — R1 co-purchase recommendations (services/recsService):
 *   1. Two orders sharing a product pair → refreshCoPurchasePairs rebuilds
 *      copurchase_pairs (claim-style delete+insert, idempotent re-run).
 *   2. getCoPurchaseForProduct returns the pair product (non-empty).
 *   3. getReorderSuggestionsForBuyer is personalized from the buyer's own
 *      order history.
 *   4. Empty state: a product that never co-occurs returns [] (fail-open).
 */
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J617",
  name: "recs: co-purchase pairs refresh, also-bought, personalized reorder, empty state",
  feature: "W64 intelligence R1: recsService co-purchase recommendations",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const {
      refreshCoPurchasePairs,
      getCoPurchaseForProduct,
      getReorderSuggestionsForBuyer,
      resetRecsCacheForTests,
    } = await import("../../server/services/recsService");
    try {
      await world.db.insert(schema.products).values([
        { id: "p-j617-a", tenantId: TENANT_ID, sku: "SIM-J617-A", name: "J617 Rice 5kg", price: "12.50", currency: "NGN", status: "active", stockQuantity: 50 },
        { id: "p-j617-b", tenantId: TENANT_ID, sku: "SIM-J617-B", name: "J617 Beans 2kg", price: "8.00", currency: "NGN", status: "active", stockQuantity: 50 },
        { id: "p-j617-lonely", tenantId: TENANT_ID, sku: "SIM-J617-L", name: "J617 Lonely Item", price: "3.00", currency: "NGN", status: "active", stockQuantity: 50 },
      ]).onConflictDoNothing();
      // Two orders sharing the (a,b) pair; buyer c-j617-buyer owns order 1.
      for (const [oid, customerId, num] of [["o-j617-1", "c-j617-buyer", "SIM-J617-1"], ["o-j617-2", "c-j617-other", "SIM-J617-2"]] as const) {
        await world.db.insert(schema.orders).values({
          id: oid, tenantId: TENANT_ID, customerId, orderNumber: num,
          status: "delivered", totalAmount: "20.50", currency: "NGN", paymentStatus: "completed",
        }).onConflictDoNothing();
        await world.db.insert(schema.orderItems).values([
          { orderId: oid, productId: "p-j617-a", productName: "J617 Rice 5kg", quantity: 1, unitPrice: "12.50", currency: "NGN" },
          { orderId: oid, productId: "p-j617-b", productName: "J617 Beans 2kg", quantity: 1, unitPrice: "8.00", currency: "NGN" },
        ]);
      }

      // ── 1. Refresh pairs (idempotent: run twice, same result) ──────────
      const r1 = await refreshCoPurchasePairs(world.db, TENANT_ID);
      // Two orders sharing (a,b) → exactly 2 directional rows (a→b, b→a),
      // each with co_count = 2 (distinct orders).
      assert(r1.pairs >= 2, `pair refresh built both directions (got ${JSON.stringify(r1)})`);
      await refreshCoPurchasePairs(world.db, TENANT_ID); // re-run is a rebuild, not a dup
      resetRecsCacheForTests();

      // ── 2. Also-bought for product a includes b with co_count 2 ────────
      const recs = await getCoPurchaseForProduct(world.db, TENANT_ID, "p-j617-a");
      const pair = recs.find((r) => r.productId === "p-j617-b");
      assert(pair, `co-purchase recs include p-j617-b (got ${JSON.stringify(recs.map((r) => r.productId))})`);
      assert(pair.score === 2, `co_count 2 from two orders (got ${pair.score})`);
      assert(pair.name === "J617 Beans 2kg" && pair.price === "8.00", "rec item carries catalog fields");

      // ── 3. Personalized reorder from the buyer's own history ───────────
      const reorder = await getReorderSuggestionsForBuyer(world.db, TENANT_ID, "c-j617-buyer");
      assert(reorder.some((r) => r.productId === "p-j617-a"), "reorder includes buyer's own product a");
      assert(reorder.some((r) => r.productId === "p-j617-b"), "reorder includes buyer's own product b");

      // ── 4. Empty state: product with no pairs → [] ─────────────────────
      resetRecsCacheForTests();
      const empty = await getCoPurchaseForProduct(world.db, TENANT_ID, "p-j617-lonely");
      assert(empty.length === 0, `empty-state product returns [] (got ${JSON.stringify(empty)})`);
    } finally {
      resetRecsCacheForTests();
      await world.db.execute(`DELETE FROM copurchase_pairs WHERE product_id LIKE 'p-j617-%' OR pair_product_id LIKE 'p-j617-%'`).catch(() => {});
      await world.db.execute(`DELETE FROM order_items WHERE "orderId" LIKE 'o-j617-%'`).catch(() => {});
      await world.db.execute(`DELETE FROM orders WHERE id LIKE 'o-j617-%'`).catch(() => {});
      await world.db.execute(`DELETE FROM products WHERE id LIKE 'p-j617-%'`).catch(() => {});
    }
  },
};
