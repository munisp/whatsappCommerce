// === W51 PROMOS ===
/**
 * J525 — merchant featured pins override the sales ranking: with
 * settings.promoDisplay.featuredProductIds = [low-seller], the "popular
 * items" browse leads with the featured product, sales ranking after.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J525",
  name: "featuredProductIds pin outranks sales in popular browse",
  feature: "W51 promos: merchant featured pins",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { __clearPopularProductsCache } = await import("../../server/services/promoSpotlight");
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({ user: null } as any);
    const before = await world.tenantSettings();
    try {
      await world.db.insert(schema.products).values([
        { id: "p-j525-hot", tenantId: TENANT_ID, sku: "SIM-J525-HOT", name: "J525 Hot Seller", price: "5.00", currency: "NGN", status: "active", stockQuantity: 9 },
        { id: "p-j525-pin", tenantId: TENANT_ID, sku: "SIM-J525-PIN", name: "J525 Pinned Gem", price: "9.00", currency: "NGN", status: "active", stockQuantity: 9 },
      ]).onConflictDoNothing();
      await world.db.insert(schema.orders).values({
        id: "o-j525-1", tenantId: TENANT_ID, customerId: "c1", orderNumber: "SIM-J525-1",
        status: "delivered", totalAmount: "5.00", currency: "NGN", paymentStatus: "completed",
      }).onConflictDoNothing();
      await world.db.insert(schema.orderItems).values({
        orderId: "o-j525-1", productId: "p-j525-hot", productName: "J525 Hot Seller",
        quantity: 9000, unitPrice: "5.00", currency: "NGN",
      });
      await world.patchTenantSettings({ promoDisplay: { featuredProductIds: ["p-j525-pin"] } });
      __clearPopularProductsCache();

      const r = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: world.newPhone("5"), message: "popular items",
      });
      const browse = (r as any).browseProducts as Array<{ id: string }>;
      assert(browse?.[0]?.id === "p-j525-pin", `featured pin first (got ${browse?.[0]?.id})`);
      assert(browse?.[1]?.id === "p-j525-hot", `sales ranking after pins (got ${browse?.[1]?.id})`);
      assert(String(r.reply).indexOf("J525 Pinned Gem") < String(r.reply).indexOf("J525 Hot Seller"),
        "numbered text list mirrors the pin-first ranking");
    } finally {
      __clearPopularProductsCache();
      await world.patchTenantSettings({ promoDisplay: (before as any)?.promoDisplay });
      await world.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, "o-j525-1")).catch(() => {});
      await world.db.delete(schema.orders).where(eq(schema.orders.id, "o-j525-1")).catch(() => {});
      await world.db.delete(schema.products).where(eq(schema.products.id, "p-j525-hot")).catch(() => {});
      await world.db.delete(schema.products).where(eq(schema.products.id, "p-j525-pin")).catch(() => {});
    }
  },
};
