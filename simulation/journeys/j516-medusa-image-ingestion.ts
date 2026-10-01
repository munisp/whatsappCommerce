// === W50 IMAGES ===
/**
 * J516 — W50 images (Coder C, Q2b): Medusa image ingestion.
 *   1. fetchMedusaCatalog requests the images expansion and maps
 *      p.thumbnail ?? p.images?.[0]?.url onto each variant row.
 *   2. importProductsToMenu (real tRPC mutation) carries the image into the
 *      menu-item metadata AND materializes/updates the products row with
 *      products.imageUrl + provenance metadata.imageSource="medusa".
 *      (Medusa URLs are public absolute — usable directly.)
 */
import { and, eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, TENANT_ID, type World } from "../world";
import { tenantCaller } from "./helpers";
import type { Journey } from "../runner";

const HOST = "medusa-j516.example.com";
const BASE = `https://${HOST}`;

export const journey: Journey = {
  id: "J516",
  name: "Medusa catalog import carries thumbnail/images[0] → products.imageUrl",
  feature: "W50 IMAGES Q2b: Medusa image ingestion",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { fetchMedusaCatalog } = await import("../../server/services/integrationSync");

    // Tenant Medusa config (public https host passes the SSRF guard).
    await world.db.delete(schema.tenantIntegrations).where(and(
      eq(schema.tenantIntegrations.tenantId, TENANT_ID),
      eq(schema.tenantIntegrations.integrationType, "medusa"),
    ));
    await world.db.insert(schema.tenantIntegrations).values({
      id: "1a516000-0000-4000-8000-000000000001",
      tenantId: TENANT_ID,
      integrationType: "medusa",
      displayName: "Medusa J516",
      baseUrl: BASE,
      apiKey: "pk_plain_j516",
      status: "active",
      enabledAt: new Date(),
    });

    erp.script(HOST, () => ({
      json: {
        products: [
          {
            id: "prod_j516_a",
            title: "J516 Ankara",
            thumbnail: "https://cdn.medusa-j516.example.com/ankara.jpg",
            variants: [{ id: "var_j516_a1", title: "6 yards", prices: [{ amount: 450000, currency_code: "ngn" }], inventory_quantity: 7 }],
          },
          {
            id: "prod_j516_b",
            title: "J516 No-Thumbnail",
            thumbnail: null,
            images: [{ url: "https://cdn.medusa-j516.example.com/fallback.jpg" }],
            variants: [{ id: "var_j516_b1", title: "one size", prices: [{ amount: 10000, currency_code: "ngn" }], inventory_quantity: 2 }],
          },
        ],
      },
    }));

    const catalog = await fetchMedusaCatalog(TENANT_ID);
    assert(catalog.length === 2, `two variants mapped (got ${catalog.length})`);
    const a = catalog.find((x) => x.id === "var_j516_a1")!;
    const b = catalog.find((x) => x.id === "var_j516_b1")!;
    assert(a.image === "https://cdn.medusa-j516.example.com/ankara.jpg", `thumbnail mapped (got ${a.image})`);
    assert(b.image === "https://cdn.medusa-j516.example.com/fallback.jpg", `images[0].url fallback (got ${b.image})`);

    // ── importProductsToMenu (real tRPC mutation path) ───────────────────
    const menuId = "1a516000-0000-4000-8000-0000000000ff";
    await world.db.insert(schema.whatsappMenus).values({
      id: menuId, tenantId: TENANT_ID, name: "J516 Menu",
    }).onConflictDoNothing();
    const caller = await tenantCaller(TENANT_ID);
    const res = await caller.medusa.importProductsToMenu({
      menuId,
      products: catalog.map((p) => ({ id: p.id, title: p.title, price: p.price, currency: p.currency, stock: p.stock, image: p.image })),
    });
    assert(res.imported === 2, "both variants imported as menu items");
    const items = await world.db.select().from(schema.whatsappMenuItems)
      .where(eq(schema.whatsappMenuItems.menuId, menuId));
    assert(items.every((i: any) => typeof i.metadata?.image === "string" && i.metadata.image.startsWith("https://")),
      "menu item metadata carries the image");

    // Products materialized with imageUrl + provenance.
    const [pa] = await world.db.select().from(schema.products)
      .where(and(eq(schema.products.tenantId, TENANT_ID), eq(schema.products.sku, "med:var_j516_a1"))).limit(1);
    assert(pa, "product row materialized for imported variant");
    assert(pa.imageUrl === "https://cdn.medusa-j516.example.com/ankara.jpg", "products.imageUrl set from Medusa thumbnail");
    assert((pa.metadata as any)?.imageSource === "medusa", "provenance imageSource=medusa");
    assert((pa.metadata as any)?.medusaVariantId === "var_j516_a1", "medusaVariantId provenance");

    // Cleanup so reruns stay deterministic.
    erp.handlers.delete(HOST);
    await world.db.delete(schema.tenantIntegrations)
      .where(eq(schema.tenantIntegrations.id, "1a516000-0000-4000-8000-000000000001"));
  },
};
