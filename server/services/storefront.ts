/**
 * server/services/storefront.ts — W27 public shareable storefronts.
 *
 * Each tenant gets a public web storefront at /shop/:slug. The slug is
 * globally unique (auto-generated default from the tenant name with a
 * deterministic seeded suffix, merchant-customizable). The storefront page
 * renders branding (theme color + hero text), the product catalog (same
 * `products` table the WhatsApp catalog flows read), prices, a WhatsApp
 * click-to-chat order CTA, and — only when the merchant opted in
 * (showLocation) AND holds an approved KYB application (same gate pattern as
 * geoDiscovery's discoverable surface) — the business location.
 *
 * PRIVACY (tracking.ts exemplar): the public view exposes ONLY
 *   - business name, theme color, hero text, default locale
 *   - product name / description / price / currency / image (active only)
 *   - click-to-chat target (the tenant's public WhatsApp business number id)
 *   - approximate location (city/country + coordinates) when doubly gated
 * It NEVER exposes: owner name/email/phone, customer data, order data,
 * stock quantities below the shelf, internal ids beyond the product id.
 *
 * Pure helpers (slugify, buildDefaultSlug, validateSlug) have no DB deps so
 * unit tests run hermetically.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  kycApplications,
  medusaStoreMappings,
  merchantLocations,
  products,
  storefronts,
  tenants,
} from "../../drizzle/schema";
import { seededRng } from "../../shared/prng";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

// ── Slug helpers (pure) ─────────────────────────────────────────────────────

export const SLUG_MAX_LEN = 80;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** Lowercase URL-safe slug core from a business name (no uniqueness suffix). */
export function slugify(name: string): string {
  const core = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return core || "shop";
}

/** Validate a merchant-supplied slug. Returns an error string or null. */
export function validateSlug(slug: string): string | null {
  if (!slug) return "slug is required";
  if (slug.length > SLUG_MAX_LEN) return `slug must be ≤ ${SLUG_MAX_LEN} characters`;
  if (!SLUG_PATTERN.test(slug)) {
    return "slug must be lowercase letters, digits and hyphens (no leading/trailing hyphen)";
  }
  return null;
}

/**
 * Default slug for a tenant: slugified name + deterministic 4-char suffix
 * derived from the tenant id (seeded PRNG — never Math.random). Deterministic
 * so re-provisioning the same tenant yields the same default.
 */
export function buildDefaultSlug(tenantId: string, businessName: string): string {
  const rng = seededRng(`storefront:${tenantId}`);
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1 (readability)
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(rng() * alphabet.length)];
  return `${slugify(businessName)}-${suffix}`;
}

// ── KYB gate ────────────────────────────────────────────────────────────────

/** True when the tenant has an approved KYB/KYC application on file. */
export async function hasApprovedKyb(db: Db, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: kycApplications.id })
    .from(kycApplications)
    .where(and(eq(kycApplications.tenantId, tenantId), eq(kycApplications.status, "approved")))
    .limit(1)
    .catch(() => []);
  return rows.length > 0;
}

// ── Public view ─────────────────────────────────────────────────────────────

export interface StorefrontProductView {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: string;
  currency: string;
  imageUrl: string | null;
  inStock: boolean;
}

export interface StorefrontPublicView {
  slug: string;
  businessName: string;
  heroText: string | null;
  themeColor: string;
  defaultLocale: string;
  /** wa.me click-to-chat target — the tenant's public WhatsApp number id. */
  whatsappPhoneNumberId: string | null;
  /**
   * W28: which catalog the view was rendered from. "platform" (default) is
   * the merchant's native catalog; "medusa" is the synced Medusa catalog
   * (only when the tenant's store mapping enables it).
   */
  catalogSource: "platform" | "medusa";
  catalog: StorefrontProductView[];
  location: {
    label: string;
    city: string | null;
    country: string | null;
    latitude: string;
    longitude: string;
  } | null;
}

/**
 * Build the PII-scrubbed public storefront view for a slug.
 * Returns null when no storefront exists for the slug or it is hidden
 * (isVisible=false) — callers map both to 404 so visibility cannot be probed.
 */
export async function getStorefrontPublicView(
  db: Db,
  slug: string,
): Promise<StorefrontPublicView | null> {
  const [sf] = await db
    .select()
    .from(storefronts)
    .where(eq(storefronts.slug, slug))
    .limit(1)
    .catch(() => []);
  if (!sf || !sf.isVisible) return null;

  const [tenant] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
      defaultCurrency: tenants.defaultCurrency,
    })
    .from(tenants)
    .where(eq(tenants.id, sf.tenantId))
    .limit(1)
    .catch(() => []);
  if (!tenant) return null;

  // W28 catalog-source resolution: the tenant's Medusa store mapping decides
  // which catalog the storefront renders. "medusa" (with sync enabled) → only
  // synced medusa-sourced rows; an explicit "platform" mapping → only
  // platform-native rows; NO mapping at all → unchanged legacy behavior (all
  // active products, no source filter).
  const [mapping] = await db
    .select({
      catalogSource: medusaStoreMappings.catalogSource,
      syncEnabled: medusaStoreMappings.syncEnabled,
    })
    .from(medusaStoreMappings)
    .where(eq(medusaStoreMappings.tenantId, sf.tenantId))
    .limit(1)
    .catch(() => []);
  const catalogSource: "platform" | "medusa" =
    mapping?.catalogSource === "medusa" && mapping.syncEnabled ? "medusa" : "platform";
  const sourceFilter = !mapping
    ? undefined
    : catalogSource === "medusa"
      ? sql`${products.metadata}->>'source' = 'medusa'`
      : sql`coalesce(${products.metadata}->>'source', 'platform') <> 'medusa'`;

  // Catalog: active products only; stock exposure limited to in/out of stock.
  const catalogRows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      category: products.category,
      price: products.price,
      currency: products.currency,
      imageUrl: products.imageUrl,
      stockQuantity: products.stockQuantity,
    })
    .from(products)
    .where(and(
      eq(products.tenantId, sf.tenantId),
      eq(products.status, "active"),
      sourceFilter,
    ))
    .orderBy(products.name)
    .limit(200)
    .catch(() => []);

  // Location: merchant opt-in (showLocation) AND approved KYB — same trust
  // gate as geoDiscovery's discoverable surface.
  let location: StorefrontPublicView["location"] = null;
  if (sf.showLocation && (await hasApprovedKyb(db, sf.tenantId))) {
    const [loc] = await db
      .select()
      .from(merchantLocations)
      .where(eq(merchantLocations.tenantId, sf.tenantId))
      .orderBy(desc(merchantLocations.createdAt))
      .limit(1)
      .catch(() => []);
    if (loc) {
      location = {
        label: loc.label,
        city: loc.city,
        country: loc.country,
        latitude: loc.latitude,
        longitude: loc.longitude,
      };
    }
  }

  return {
    slug: sf.slug,
    businessName: tenant.name,
    heroText: sf.heroText,
    themeColor: sf.themeColor,
    defaultLocale: sf.defaultLocale,
    whatsappPhoneNumberId: tenant.whatsappPhoneNumberId ?? null,
    catalogSource,
    catalog: catalogRows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      price: String(p.price),
      currency: p.currency,
      imageUrl: p.imageUrl,
      inStock: (p.stockQuantity ?? 0) > 0,
    })),
    location,
  };
}

// ── Tenant self-service ─────────────────────────────────────────────────────

export interface StorefrontSettingsInput {
  slug?: string;
  heroText?: string | null;
  themeColor?: string;
  isVisible?: boolean;
  showLocation?: boolean;
  defaultLocale?: string;
}

/**
 * Upsert the tenant's storefront row. Slug handling:
 *  - no row yet → provided slug (validated) or the deterministic default
 *  - slug change → validated + uniqueness-checked across tenants
 *  - uniqueness conflict → TRPC-safe CONFLICT signal via thrown {code}
 */
export async function upsertStorefront(
  db: Db,
  tenantId: string,
  businessName: string,
  input: StorefrontSettingsInput,
): Promise<{ storefront: typeof storefronts.$inferSelect; created: boolean }> {
  const [existing] = await db
    .select()
    .from(storefronts)
    .where(eq(storefronts.tenantId, tenantId))
    .limit(1);

  let slug = existing?.slug ?? null;
  if (input.slug != null && input.slug !== existing?.slug) {
    const err = validateSlug(input.slug);
    if (err) throw Object.assign(new Error(err), { code: "BAD_REQUEST" });
    slug = input.slug;
  }
  if (!slug) slug = buildDefaultSlug(tenantId, businessName);

  const values = {
    tenantId,
    slug,
    heroText: input.heroText !== undefined ? input.heroText : (existing?.heroText ?? null),
    themeColor: input.themeColor ?? existing?.themeColor ?? "#075E54",
    isVisible: input.isVisible ?? existing?.isVisible ?? false,
    showLocation: input.showLocation ?? existing?.showLocation ?? false,
    defaultLocale: input.defaultLocale ?? existing?.defaultLocale ?? "en",
    updatedAt: new Date(),
  };

  if (existing) {
    const [row] = await db
      .update(storefronts)
      .set(values)
      .where(eq(storefronts.id, existing.id))
      .returning();
    return { storefront: row, created: false };
  }
  const [row] = await db.insert(storefronts).values(values).returning();
  return { storefront: row, created: true };
}
