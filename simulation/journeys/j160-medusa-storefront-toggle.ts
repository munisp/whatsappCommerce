/**
 * J160 — W28 storefront catalog-source toggle.
 *
 * A published storefront renders its platform-native catalog by default.
 * After the tenant connects a Medusa store and backfills, the public view
 * STILL shows only platform products (mapping default = platform; synced
 * medusa rows are excluded). Toggling catalogSource to "medusa" switches the
 * SAME hardened public view-model to the synced medusa catalog; toggling
 * back reverts cleanly. A storefront whose tenant has NO mapping renders
 * exactly the legacy behavior (all active products, no source filter).
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J160",
  name: "storefront renders medusa catalog after toggle",
  feature: "catalog-source resolution in the public storefront view-model",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { mockMedusaAdapter } = await import("../../server/services/medusa/adapter");
    const pub = await publicCaller();
    const admin = await adminCaller();

    const tenantA = (await admin.onboarding.start({ name: "J160 Zaria Silks" })).tenantId;
    const tenantB = (await admin.onboarding.start({ name: "J160 Enugu Pottery" })).tenantId;
    const callerA = await tenantCaller(tenantA, { userId: 1601 });
    const callerB = await tenantCaller(tenantB, { userId: 1602 });

    for (const [caller, slug] of [[callerA, "j160-silks"], [callerB, "j160-pottery"]] as const) {
      await caller.storefront.merchant.upsertSettings({ slug, isVisible: true });
    }

    await world.db.insert(schema.products).values([
      { id: "j160-a-native", tenantId: tenantA, sku: "SILK-1", name: "Silk Wrapper", price: "15000.00", currency: "NGN", stockQuantity: 4, status: "active" },
      { id: "j160-b-native", tenantId: tenantB, sku: "POT-1", name: "Clay Pot", price: "2500.00", currency: "NGN", stockQuantity: 9, status: "active" },
    ]).onConflictDoNothing();

    // ── Default: platform catalog ───────────────────────────────────────
    const before = await pub.storefront.getBySlug({ slug: "j160-silks" });
    assert(before.catalogSource === "platform", "default source is platform");
    assert(before.catalog.some((p) => p.id === "j160-a-native"), "native product listed");

    // ── Connect + backfill (mock medusa catalog) ────────────────────────
    await callerA.medusa.upsertMapping({
      baseUrl: "https://medusa.sim.local",
      apiKey: "sk_sim_j160",
      medusaSalesChannelId: "sc_j160",
    });
    mockMedusaAdapter.seedProducts([
      {
        id: "prod_j160",
        title: "Medusa Silk Scarf",
        status: "published",
        sales_channels: [{ id: "sc_j160" }],
        variants: [{ id: "var_j160", title: "Default", prices: [{ currency_code: "ngn", amount: 750000 }], inventory_quantity: 12 }],
      },
    ]);
    const backfill = await callerA.medusa.backfillCatalog();
    assert(backfill.created === 1, "one medusa product synced");

    // ── Mapping exists but source is still platform → medusa rows hidden ─
    const stillPlatform = await pub.storefront.getBySlug({ slug: "j160-silks" });
    assert(stillPlatform.catalogSource === "platform", "source unchanged until toggled");
    assert(stillPlatform.catalog.some((p) => p.id === "j160-a-native"), "native product still listed");
    assert(!stillPlatform.catalog.some((p) => p.name === "Medusa Silk Scarf"), "synced medusa product hidden pre-toggle");

    // ── Toggle to medusa → same view-model, medusa catalog ──────────────
    await callerA.medusa.setCatalogSource({ source: "medusa" });
    const medusaView = await pub.storefront.getBySlug({ slug: "j160-silks" });
    assert(medusaView.catalogSource === "medusa", "source toggled to medusa");
    assert(medusaView.catalog.length === 1 && medusaView.catalog[0].name === "Medusa Silk Scarf", "medusa catalog rendered");
    assert(medusaView.catalog[0].price === "7500.00", "synced price rendered exactly");
    assert(medusaView.catalog[0].inStock === true, "stock exposure limited to in/out");
    assert(!medusaView.catalog.some((p) => p.id === "j160-a-native"), "platform-native product hidden while medusa source active");
    // Same hardened view-model shape.
    assert(typeof medusaView.businessName === "string" && "themeColor" in medusaView, "same public view-model");

    // ── Toggle back → clean revert ──────────────────────────────────────
    await callerA.medusa.setCatalogSource({ source: "platform" });
    const reverted = await pub.storefront.getBySlug({ slug: "j160-silks" });
    assert(reverted.catalogSource === "platform", "reverted to platform");
    assert(reverted.catalog.some((p) => p.id === "j160-a-native"), "native product back");
    assert(!reverted.catalog.some((p) => p.name === "Medusa Silk Scarf"), "medusa product hidden again");

    // ── Tenant B (NO mapping) → legacy behavior unchanged ───────────────
    const legacy = await pub.storefront.getBySlug({ slug: "j160-pottery" });
    assert(legacy.catalogSource === "platform", "no-mapping tenant reports platform");
    assert(legacy.catalog.some((p) => p.id === "j160-b-native"), "no-mapping tenant lists all active products");
  },
};
