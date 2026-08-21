/**
 * J135 — W27 public shareable storefronts: render + slug uniqueness.
 *
 *   1. Tenant A saves storefront settings with an explicit slug and
 *      publishes; the public surface returns the PII-scrubbed view
 *      (branding + catalog, no owner/customer PII, stock only as in/out).
 *   2. Slug uniqueness: tenant B asking for the SAME slug gets CONFLICT;
 *      with no slug, each tenant gets a deterministic auto-generated default
 *      (same input → same slug, distinct per tenant).
 *   3. Visibility: isVisible=false → public getBySlug is NOT_FOUND
 *      (indistinguishable from an unknown slug).
 *   4. Location gate: showLocation=true without approved KYB → location is
 *      NOT published; with an approved KYB application + merchant location →
 *      city/country + coordinates appear (geoDiscovery gate pattern).
 *   5. Slug validation: invalid slugs are rejected with BAD_REQUEST.
 */
import { assert } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J135",
  name: "storefront render + slug uniqueness",
  feature: "public /shop/:slug view, slug uniqueness + defaults, visibility + KYB location gates",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { buildDefaultSlug } = await import("../../server/services/storefront");
    const admin = await adminCaller();
    const pub = await publicCaller();

    const tenantA = (await admin.onboarding.start({ name: "J135 Adire Threads" })).tenantId;
    const tenantB = (await admin.onboarding.start({ name: "J135 Kano Grains" })).tenantId;
    const callerA = await tenantCaller(tenantA, { userId: 1351 });
    const callerB = await tenantCaller(tenantB, { userId: 1352 });

    // ── 5 (early): invalid slugs rejected ────────────────────────────────
    await expectTrpcError(
      callerA.storefront.merchant.upsertSettings({ slug: "Bad Slug!" }),
      "BAD_REQUEST",
      "invalid slug rejected",
    );

    // ── 1. Tenant A: explicit slug + publish ─────────────────────────────
    const saved = await callerA.storefront.merchant.upsertSettings({
      slug: "j135-adire",
      heroText: "Hand-dyed adire fabrics from Ibadan",
      themeColor: "#123456",
      isVisible: true,
    });
    assert(saved.storefront.slug === "j135-adire", `slug saved (got ${saved.storefront.slug})`);
    assert(saved.storefront.isVisible === true, "storefront published");

    // Catalog rows (synced WhatsApp catalog products).
    await world.db.insert(schema.products).values([
      { id: "j135-p1", tenantId: tenantA, sku: "ADIRE-1", name: "Adire Wrapper", price: "8500.00", currency: "NGN", stockQuantity: 4, status: "active" },
      { id: "j135-p2", tenantId: tenantA, sku: "ADIRE-2", name: "Adire Scarf", price: "3200.00", currency: "NGN", stockQuantity: 0, status: "active" },
      { id: "j135-p3", tenantId: tenantA, sku: "ADIRE-DRAFT", name: "Unlisted Piece", price: "100.00", currency: "NGN", stockQuantity: 9, status: "inactive" },
    ]).onConflictDoNothing();

    const view = await pub.storefront.getBySlug({ slug: "j135-adire" });
    assert(view.businessName === "J135 Adire Threads", `public name (got ${view.businessName})`);
    assert(view.heroText === "Hand-dyed adire fabrics from Ibadan", "hero text rendered");
    assert(view.themeColor === "#123456", "theme color rendered");
    assert(view.catalog.length === 2, `only active products shown (got ${view.catalog.length})`);
    const scarf = view.catalog.find((p) => p.name === "Adire Scarf");
    assert(scarf && scarf.inStock === false, "out-of-stock flagged without exposing quantity");
    const wrapper = view.catalog.find((p) => p.name === "Adire Wrapper");
    assert(wrapper && wrapper.inStock === true && (wrapper as any).stockQuantity === undefined,
      "no raw stock quantity leaks to the public view");
    assert((view as any).tenantId === undefined, "no tenant id leaks");
    assert(view.location === null, "location off by default");

    // ── 2. Slug uniqueness + deterministic defaults ──────────────────────
    await expectTrpcError(
      callerB.storefront.merchant.upsertSettings({ slug: "j135-adire" }),
      "CONFLICT",
      "second tenant cannot take tenant A's slug",
    );
    const autoA = buildDefaultSlug(tenantA, "J135 Adire Threads");
    const autoB = buildDefaultSlug(tenantB, "J135 Kano Grains");
    assert(autoA === buildDefaultSlug(tenantA, "J135 Adire Threads"), "default slug deterministic");
    assert(autoA !== autoB, "default slugs differ per tenant");
    const savedB = await callerB.storefront.merchant.upsertSettings({ isVisible: true });
    assert(savedB.storefront.slug === autoB, `no-slug save uses the deterministic default (got ${savedB.storefront.slug})`);
    const viewB = await pub.storefront.getBySlug({ slug: autoB });
    assert(viewB.businessName === "J135 Kano Grains", "auto-slug storefront resolves publicly");

    // ── 3. Visibility gate ───────────────────────────────────────────────
    await callerB.storefront.merchant.setVisibility({ isVisible: false });
    await expectTrpcError(pub.storefront.getBySlug({ slug: autoB }), "NOT_FOUND", "hidden storefront 404s");
    await expectTrpcError(pub.storefront.getBySlug({ slug: "j135-no-such-shop" }), "NOT_FOUND", "unknown slug 404s identically");

    // ── 4. Location gate: opt-in alone is not enough; needs approved KYB ──
    await world.db.insert(schema.merchantLocations).values({
      tenantId: tenantA, label: "Main branch", latitude: "7.3775000", longitude: "3.9470000",
      city: "Ibadan", country: "Nigeria", geohash: "s12345", discoverable: true,
    }).onConflictDoNothing();
    await callerA.storefront.merchant.upsertSettings({ showLocation: true });
    let viewA2 = await pub.storefront.getBySlug({ slug: "j135-adire" });
    assert(viewA2.location === null, "location NOT published without approved KYB");

    await world.db.insert(schema.kycApplications).values({
      id: "j135-kyb-a", tenantId: tenantA, type: "kyb", status: "approved",
      businessName: "J135 Adire Threads", approvedAt: new Date(),
    }).onConflictDoNothing();
    viewA2 = await pub.storefront.getBySlug({ slug: "j135-adire" });
    assert(viewA2.location?.city === "Ibadan", "location published after KYB approval + opt-in");
    assert((viewA2.location as any)?.addressLine === undefined, "street address not exposed");
  },
};
