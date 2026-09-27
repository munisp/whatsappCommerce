// === W51 PROMOS ===
/**
 * J530 — featured/popular signals sync into Medusa product metadata:
 * POST /admin/products/{medusaId} with { featured, popular_rank,
 * badge: "most_ordered" } for featured pins + top sellers — covering
 * Medusa-imported products (metadata.medusaId is the link).
 */
import { and, eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

const HOST = "medusa-j530.example.com";

export const journey: Journey = {
  id: "J530",
  name: "featured/popular + badge sync into Medusa product metadata",
  feature: "W51 promos: Medusa storefront highlights",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { __clearPopularProductsCache } = await import("../../server/services/promoSpotlight");
    const { syncHighlightsToMedusa } = await import("../../server/services/medusaPromoSync");
    const before = await world.tenantSettings();
    try {
      await world.db.insert(schema.tenantIntegrations).values({
        tenantId: TENANT_ID, integrationType: "medusa", status: "active",
        baseUrl: `http://${HOST}`, apiKey: "j530-admin-token",
      }).onConflictDoNothing();
      erp.script(HOST, () => ({ json: { product: { id: "ok" } } }));
      // One Medusa-imported top seller, one featured pin, one untracked.
      await world.db.insert(schema.products).values([
        { id: "p-j530-hot", tenantId: TENANT_ID, sku: "SIM-J530-HOT", name: "J530 Hot", price: "5.00", currency: "NGN", status: "active", stockQuantity: 9, metadata: { medusaId: "medusa_hot_530", syncSource: "medusa" } },
        { id: "p-j530-pin", tenantId: TENANT_ID, sku: "SIM-J530-PIN", name: "J530 Pin", price: "9.00", currency: "NGN", status: "active", stockQuantity: 9, metadata: { medusaId: "medusa_pin_530" } },
        { id: "p-j530-off", tenantId: TENANT_ID, sku: "SIM-J530-OFF", name: "J530 Off", price: "1.00", currency: "NGN", status: "active", stockQuantity: 9, metadata: { medusaId: "medusa_off_530" } },
      ]).onConflictDoNothing();
      await world.db.insert(schema.orders).values({
        id: "o-j530-1", tenantId: TENANT_ID, customerId: "c1", orderNumber: "SIM-J530-1",
        status: "delivered", totalAmount: "5.00", currency: "NGN", paymentStatus: "completed",
      }).onConflictDoNothing();
      await world.db.insert(schema.orderItems).values({
        orderId: "o-j530-1", productId: "p-j530-hot", productName: "J530 Hot",
        quantity: 7000, unitPrice: "5.00", currency: "NGN",
      });
      await world.patchTenantSettings({ promoDisplay: { featuredProductIds: ["p-j530-pin"] } });
      __clearPopularProductsCache();

      const res = await syncHighlightsToMedusa(world.db, TENANT_ID);
      assert(res.synced === 2, `two linked products synced (got ${res.synced})`);
      const posts = erp.calls.filter((c) => c.url.includes("/admin/products/") && c.method === "POST");
      const hot = posts.find((c) => c.url.endsWith("/admin/products/medusa_hot_530"));
      const pin = posts.find((c) => c.url.endsWith("/admin/products/medusa_pin_530"));
      assert(hot, "top seller metadata pushed");
      assert(hot!.body?.metadata?.popular_rank === 1, `popular_rank=1 (got ${hot!.body?.metadata?.popular_rank})`);
      assert(hot!.body?.metadata?.badge === "most_ordered", "top-3 badge");
      assert(pin, "featured pin metadata pushed");
      assert(pin!.body?.metadata?.featured === true, "featured flag set");
      assert(!posts.some((c) => c.url.endsWith("/admin/products/medusa_off_530")), "untracked product untouched");
    } finally {
      erp.handlers.delete(HOST);
      __clearPopularProductsCache();
      await world.patchTenantSettings({ promoDisplay: (before as any)?.promoDisplay });
      await world.db.delete(schema.tenantIntegrations)
        .where(and(eq(schema.tenantIntegrations.tenantId, TENANT_ID), eq(schema.tenantIntegrations.integrationType, "medusa")))
        .catch(() => {});
      await world.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, "o-j530-1")).catch(() => {});
      await world.db.delete(schema.orders).where(eq(schema.orders.id, "o-j530-1")).catch(() => {});
      for (const id of ["p-j530-hot", "p-j530-pin", "p-j530-off"]) {
        await world.db.delete(schema.products).where(eq(schema.products.id, id)).catch(() => {});
      }
    }
  },
};
