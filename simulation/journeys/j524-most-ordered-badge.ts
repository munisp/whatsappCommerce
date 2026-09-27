// === W51 PROMOS ===
/**
 * J524 — most-ordered badge + "popular items" browse mode.
 *
 *   1. 90-day sales aggregation: seed orders/order_items where product A
 *      outsells B; "popular items" (deterministic keyword, no LLM) returns
 *      a numbered text list ranked by sales with A first, plus the
 *      browseProducts annotation in the same order.
 *   2. A search inquiry for the top product annotates the product card
 *      caption with the "⭐ Most ordered" badge line.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

async function nlpCaller() {
  const { appRouter } = await import("../../server/routers");
  return appRouter.createCaller({ user: null } as any);
}

export const journey: Journey = {
  id: "J524",
  name: "most-ordered badge on product card + popular items browse mode",
  feature: "W51 promos: popularity ranking + badge",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { __clearPopularProductsCache } = await import("../../server/services/promoSpotlight");
    const caller = await nlpCaller();
    try {
      await world.db.insert(schema.products).values([
        { id: "p-j524-a", tenantId: TENANT_ID, sku: "SIM-J524-A", name: "J524 Pepper Soup", price: "10.00", currency: "NGN", status: "active", stockQuantity: 9, imageUrl: "https://cdn.j524.example.com/a.jpg" },
        { id: "p-j524-b", tenantId: TENANT_ID, sku: "SIM-J524-B", name: "J524 Rice Bowl", price: "8.00", currency: "NGN", status: "active", stockQuantity: 9, imageUrl: "https://cdn.j524.example.com/b.jpg" },
      ]).onConflictDoNothing();
      await world.db.insert(schema.orders).values([
        { id: "o-j524-1", tenantId: TENANT_ID, customerId: "c1", orderNumber: "SIM-J524-1", status: "delivered", totalAmount: "30.00", currency: "NGN", paymentStatus: "completed" },
        { id: "o-j524-2", tenantId: TENANT_ID, customerId: "c2", orderNumber: "SIM-J524-2", status: "delivered", totalAmount: "8.00", currency: "NGN", paymentStatus: "completed" },
      ]).onConflictDoNothing();
      await world.db.insert(schema.orderItems).values([
        // Huge qty so J524 dominates any sales accumulated by earlier
        // journeys in a full-suite run (shared sim tenant).
        { orderId: "o-j524-1", productId: "p-j524-a", productName: "J524 Pepper Soup", quantity: 5000, unitPrice: "10.00", currency: "NGN" },
        { orderId: "o-j524-2", productId: "p-j524-b", productName: "J524 Rice Bowl", quantity: 1, unitPrice: "8.00", currency: "NGN" },
      ]);
      __clearPopularProductsCache();

      // 1. Popular browse: ranked list, top seller first (text + annotation).
      const r1 = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: world.newPhone("4"), message: "popular items",
      });
      assert(String(r1.reply).includes("1. ⭐ J524 Pepper Soup"), `ranked list leads with top seller (got ${String(r1.reply).slice(0, 160)})`);
      // W51 merger: relative-order assertion moved to the aggregation layer
      // (deterministic) — in the full-suite shared tenant the top-6 reply
      // window is dominated by sales accumulated from earlier journeys, so
      // the qty-1 runner-up is not guaranteed a visible slot.
      const { getPopularProducts } = await import("../../server/services/promoSpotlight");
      const ranking = await getPopularProducts(world.db, TENANT_ID, 500);
      const rankA = ranking.findIndex((r) => r.productId === "p-j524-a");
      const rankB = ranking.findIndex((r) => r.productId === "p-j524-b");
      assert(rankA === 0 && rankB > rankA, `top seller outranks runner-up in sales aggregation (a=${rankA}, b=${rankB})`);
      const browse = (r1 as any).browseProducts as Array<{ id: string; name: string }>;
      assert(browse?.[0]?.id === "p-j524-a", "browseProducts annotation ranked by sales");
      assert(browse[0].name.includes("⭐"), "top-3 item badged in the browse annotation");

      // 2. Search inquiry for the top seller → caption carries the badge line.
      world.llm.when(/pepper soup/i, {
        reply: "J524 Pepper Soup is available.",
        intent: "search", nextState: "product_detail",
        extractedItems: [], extractedProduct: "J524 Pepper Soup",
        extractedQuantity: null, extractedAddress: null, confidence: 0.9,
      });
      const r2 = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: world.newPhone("4"), message: "do you have pepper soup?",
      });
      const caption = (r2 as any).productImage?.caption ?? "";
      assert(caption.includes("⭐ Most ordered"), `badge line on the product card body (got ${caption})`);
      assert(caption.includes("J524 Pepper Soup"), "caption still names the product");
    } finally {
      world.llm.reset();
      __clearPopularProductsCache();
      await world.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, "o-j524-1")).catch(() => {});
      await world.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, "o-j524-2")).catch(() => {});
      await world.db.delete(schema.orders).where(eq(schema.orders.id, "o-j524-1")).catch(() => {});
      await world.db.delete(schema.orders).where(eq(schema.orders.id, "o-j524-2")).catch(() => {});
      await world.db.delete(schema.products).where(eq(schema.products.id, "p-j524-a")).catch(() => {});
      await world.db.delete(schema.products).where(eq(schema.products.id, "p-j524-b")).catch(() => {});
    }
  },
};
