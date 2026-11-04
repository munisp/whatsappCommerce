/**
 * The public side of a store: its design, contact details and catalogue, scoped to one tenant.
 * Stock is only exposed as in stock / low / out, never as a count.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { medusaStoreMappings, productVariants, products, reviews, storefronts, tenants } from "../../../drizzle/schema";
import { storeConfigSchema, type StoreConfig } from "../../../shared/storefront/config";
import { DEFAULT_TEMPLATE_ID, findTemplate } from "../../../shared/storefront/templates";

export type Db = NonNullable<Awaited<ReturnType<typeof import("../../db").getDb>>>;
type TenantRow = { id: string; name: string; slug: string | null; whatsappPhoneNumberId: string | null; defaultCurrency: string | null; settings: unknown };

export interface LoadedStore { storefront: typeof storefronts.$inferSelect; tenant: TenantRow; config: StoreConfig }

const LOW_STOCK_AT = 5;

/** What a store looks like before its owner has published a design: the default template in their colour. */
export function defaultConfigFor(sf: { heroText: string | null; themeColor: string }): StoreConfig {
  const base = findTemplate(DEFAULT_TEMPLATE_ID)!.config;
  return {
    ...base,
    theme: { ...base.theme, accent: sf.themeColor, inverse: sf.themeColor },
    sections: base.sections.map((s) => (s.type === "hero" && sf.heroText ? { ...s, title: sf.heroText } : s)),
  };
}

export function parseConfig(raw: unknown): StoreConfig | null {
  const parsed = storeConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The store for a slug. Hidden and unknown slugs look the same, unless its own staff are previewing. */
export async function loadStore(db: Db, slug: string, opts: { previewTenantId?: string | null } = {}): Promise<LoadedStore | null> {
  const [sf] = await db.select().from(storefronts).where(eq(storefronts.slug, slug.toLowerCase())).limit(1);
  if (!sf) return null;
  const isOwnPreview = !!opts.previewTenantId && opts.previewTenantId === sf.tenantId;
  if (!sf.isVisible && !isOwnPreview) return null;
  const [tenant] = await db.select({
    id: tenants.id, name: tenants.name, slug: tenants.slug, whatsappPhoneNumberId: tenants.whatsappPhoneNumberId, defaultCurrency: tenants.defaultCurrency, settings: tenants.settings,
  }).from(tenants).where(eq(tenants.id, sf.tenantId)).limit(1);
  if (!tenant) return null;
  const raw = isOwnPreview ? (sf.draftConfig ?? sf.publishedConfig) : sf.publishedConfig;
  return { storefront: sf, tenant, config: parseConfig(raw) ?? defaultConfigFor(sf) };
}

/** WhatsApp number as wa.me expects it: digits only. The Meta phone-number ID is not a phone number. */
export function resolveWhatsappNumber(config: StoreConfig, settings: unknown): string | null {
  const root = (settings ?? {}) as { whatsapp?: { displayPhoneNumber?: unknown }; support?: { phone?: unknown } };
  for (const candidate of [config.contact.whatsapp, root.whatsapp?.displayPhoneNumber, root.support?.phone]) {
    const digits = typeof candidate === "string" ? candidate.replace(/\D/g, "") : "";
    if (digits.length >= 8 && digits.length <= 15) return digits;
  }
  return null;
}

/**
 * Where a store's WhatsApp buttons go. Shops without their own connected number sell through the shared platform
 * number, so that's the default; shopRef is then what routes the customer to this shop rather than the directory.
 */
export function resolveWhatsapp(
  config: StoreConfig,
  tenant: Pick<TenantRow, "settings" | "slug" | "whatsappPhoneNumberId">,
  sharedNumber: string | undefined = process.env.SHARED_WA_DISPLAY_NUMBER,
): { number: string | null; shopRef: string | null; shared: boolean } {
  const own = resolveWhatsappNumber(config, tenant.settings);
  if (own) return { number: own, shopRef: null, shared: false };
  const shared = (sharedNumber ?? "").replace(/\D/g, "");
  // A shop on its own number isn't reachable through the shared line (see resolveShopRef).
  if (tenant.whatsappPhoneNumberId || !tenant.slug || shared.length < 8) return { number: null, shopRef: null, shared: false };
  return { number: shared, shopRef: tenant.slug, shared: true };
}

export function checkoutOptions(settings: unknown) {
  const commerce = ((settings ?? {}) as { commerce?: { pickupEnabled?: boolean; codEnabled?: boolean } }).commerce ?? {};
  return { pickup: commerce.pickupEnabled !== false, cod: commerce.codEnabled !== false };
}

/** The same catalogue rule as the original storefront: Medusa-mapped shops show only their synced products. */
async function catalogFilter(db: Db, tenantId: string) {
  const [mapping] = await db.select({
    catalogSource: medusaStoreMappings.catalogSource, syncEnabled: medusaStoreMappings.syncEnabled,
  }).from(medusaStoreMappings).where(eq(medusaStoreMappings.tenantId, tenantId)).limit(1).catch(() => []);
  if (!mapping) return undefined;
  return mapping.catalogSource === "medusa" && mapping.syncEnabled
    ? sql`${products.metadata}->>'source' = 'medusa'`
    : sql`coalesce(${products.metadata}->>'source', 'platform') <> 'medusa'`;
}

export interface StoreProduct {
  id: string; name: string; description: string | null; category: string | null; price: string; currency: string;
  compareAtPrice: string | null; imageUrl: string | null; images: string[]; inStock: boolean; lowStock: boolean;
  sold: number; isNew: boolean; featured: boolean; preorder: boolean; ageRestricted: boolean; minAge: number | null;
  options: { name: string; values: string[] }[];
  variants: { id: string; label: string; attributes: Record<string, string>; inStock: boolean }[];
}

function toStoreProduct(row: typeof products.$inferSelect, extras: {
  sold: number; featured: boolean; variants: (typeof productVariants.$inferSelect)[]; now: number;
}): StoreProduct {
  const meta = (row.metadata ?? {}) as { compareAtPrice?: unknown; images?: unknown };
  const compare = Number(meta.compareAtPrice);
  const images = Array.isArray(meta.images) ? meta.images.filter((i): i is string => typeof i === "string") : [];
  const hasVariants = extras.variants.length > 0;
  const stock = hasVariants ? extras.variants.reduce((sum, v) => sum + v.stockQuantity, 0) : row.stockQuantity;
  const optionMap = new Map<string, Set<string>>();
  for (const v of extras.variants) {
    for (const [k, val] of Object.entries((v.attributes ?? {}) as Record<string, unknown>)) {
      if (typeof val !== "string") continue;
      if (!optionMap.has(k)) optionMap.set(k, new Set());
      optionMap.get(k)!.add(val);
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: row.price,
    currency: row.currency,
    compareAtPrice: Number.isFinite(compare) && compare > Number(row.price) ? compare.toFixed(2) : null,
    imageUrl: row.imageUrl,
    images: [...(row.imageUrl ? [row.imageUrl] : []), ...images.filter((i) => i !== row.imageUrl)],
    inStock: stock > 0 || row.preorderEnabled,
    lowStock: stock > 0 && stock <= LOW_STOCK_AT,
    sold: extras.sold,
    isNew: extras.now - new Date(row.createdAt).getTime() < 30 * 86_400_000,
    featured: extras.featured,
    preorder: row.preorderEnabled,
    ageRestricted: row.ageRestricted,
    minAge: row.minAge,
    options: Array.from(optionMap).map(([name, values]) => ({ name, values: Array.from(values) })),
    variants: extras.variants.map((v) => ({
      id: v.id,
      label: v.name ?? Object.values((v.attributes ?? {}) as Record<string, string>).join(" / "),
      attributes: (v.attributes ?? {}) as Record<string, string>,
      inStock: v.stockQuantity > 0,
    })),
  };
}

/** Every active product for the store, with what listings need to sort and badge it. */
export async function loadCatalog(db: Db, store: LoadedStore): Promise<StoreProduct[]> {
  const tenantId = store.tenant.id;
  const filter = await catalogFilter(db, tenantId);
  const rows = await db.select().from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.status, "active"), filter))
    .orderBy(desc(products.createdAt)).limit(500);
  if (rows.length === 0) return [];
  const { getPopularProducts, getPromoSpotSettings } = await import("../promoSpotlight");
  const [popular, variantRows] = await Promise.all([
    getPopularProducts(db, tenantId, 100).catch(() => []),
    db.select().from(productVariants).where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, rows.map((r) => r.id)))),
  ]);
  const featured = new Set(getPromoSpotSettings(store.tenant.settings).featuredProductIds);
  const soldBy = new Map(popular.map((p, i) => [p.productId, 100 - i]));
  const now = Date.now();
  return rows.map((row) => toStoreProduct(row, {
    sold: soldBy.get(row.id) ?? 0,
    featured: featured.has(row.id),
    variants: variantRows.filter((v) => v.productId === row.id),
    now,
  }));
}

export type CatalogSort = "featured" | "newest" | "price_asc" | "price_desc" | "popular" | "name";

export interface CatalogQuery {
  q?: string; category?: string; sort?: CatalogSort; minPrice?: number; maxPrice?: number;
  inStock?: boolean; onSale?: boolean; page?: number; pageSize?: number;
}

/** Pure search, filter and sort so it behaves the same on a real store and a template preview. */
export function queryCatalog<T extends Pick<StoreProduct, "name" | "description" | "category" | "price" | "compareAtPrice" | "inStock" | "sold" | "featured" | "isNew">>(all: T[], query: CatalogQuery) {
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  let list = all.filter((p) => {
    if (query.category && p.category !== query.category) return false;
    const price = Number(p.price);
    if (query.minPrice != null && price < query.minPrice) return false;
    if (query.maxPrice != null && price > query.maxPrice) return false;
    if (query.inStock && !p.inStock) return false;
    if (query.onSale && !p.compareAtPrice) return false;
    if (words.length) {
      const hay = `${p.name} ${p.description ?? ""} ${p.category ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const byPrice = (a: T, b: T) => Number(a.price) - Number(b.price);
  switch (query.sort ?? "featured") {
    case "price_asc": list = [...list].sort(byPrice); break;
    case "price_desc": list = [...list].sort((a, b) => byPrice(b, a)); break;
    case "popular": list = [...list].sort((a, b) => b.sold - a.sold); break;
    case "name": list = [...list].sort((a, b) => a.name.localeCompare(b.name)); break;
    case "newest": break; // loaded newest first
    default: list = [...list].sort((a, b) => Number(b.featured) - Number(a.featured) || b.sold - a.sold);
  }
  const pageSize = query.pageSize ?? 24;
  const page = Math.max(1, query.page ?? 1);
  return {
    total: list.length,
    page,
    pageCount: Math.max(1, Math.ceil(list.length / pageSize)),
    items: list.slice((page - 1) * pageSize, page * pageSize),
  };
}

export function categoriesOf(all: Pick<StoreProduct, "category" | "imageUrl">[]) {
  const seen = new Map<string, { name: string; imageUrl: string | null; count: number }>();
  for (const p of all) {
    if (!p.category) continue;
    const entry = seen.get(p.category) ?? { name: p.category, imageUrl: p.imageUrl, count: 0 };
    entry.count += 1;
    entry.imageUrl = entry.imageUrl ?? p.imageUrl;
    seen.set(p.category, entry);
  }
  return Array.from(seen.values());
}

/** Only genuine, published reviews. A store with none shows none. Authors are reduced to initials-free "Verified buyer". */
export async function publishedReviews(db: Db, tenantId: string, productId?: string) {
  const rows = await db.select({
    rating: reviews.rating, text: reviews.text, createdAt: reviews.createdAt, productId: reviews.productId,
  }).from(reviews).where(and(
    eq(reviews.tenantId, tenantId),
    eq(reviews.status, "published"),
    productId ? eq(reviews.productId, productId) : undefined,
  )).orderBy(desc(reviews.createdAt)).limit(productId ? 20 : 30);
  return rows.filter((r) => r.text && r.text.trim()).map((r) => ({ rating: r.rating, text: r.text as string, productId: r.productId }));
}
