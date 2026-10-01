// === W51 PROMOS ===
/**
 * promoSpotlight.ts — dynamic promotion spotlight + most-ordered display
 * across all chat channels (WA / Telegram / USSD / SMS).
 *
 * Pieces:
 *   - getActivePromos(settings, now): settings.promos filtered to currently
 *     valid + enabled codes (reuses getPromosFromSettings sanitization).
 *   - getSpotlightPromos(db, tenantId, settings): promo codes + active group
 *     deals + time-boxed flash offers (settings.promos.flashOffers), first
 *     entry is the spotlight card.
 *   - getPopularProducts(db, tenantId, limit): order_items ⨝ orders quantity
 *     aggregation (tenant-scoped, last 90 days), 5-minute read-through cache
 *     (waTenantLookup pattern: in-proc Map, fail-open).
 *   - rankForDisplay(products, popular, featured): merchant featured pins
 *     (settings.promos.featuredProductIds) first, then sales ranking.
 *   - Channel renderers: WA interactive image-header card, TG photo+keyboard
 *     card, USSD/SMS one-liner. All senders fail-open.
 *
 * Money discipline: percent promos carry the integer percent; fixed promos
 * carry MAJOR-unit values exactly as configured (discount math stays in the
 * integer-minor-units engine in promos.ts — this module only renders).
 *
 * Tenant toggles (settings.promos):
 *   showActive            (default true)  — master spotlight switch
 *   spotlightProductIds   string[]        — curated product image for the card
 *   featuredProductIds    string[]        — pins that outrank sales ranking
 *   flashOffers           Array<{ title, discountPercent, imageUrl?, expiresAt? }>
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { orders, orderItems, products, tenants } from "../../drizzle/schema";
import { getPromosFromSettings, type Promo } from "./promos";
import { t27, type Locale } from "./i18n";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ── Settings shape ───────────────────────────────────────────────────────────

export interface PromoSpotSettings {
  showActive: boolean;
  spotlightProductIds: string[];
  featuredProductIds: string[];
  flashOffers: Array<{ title: string; discountPercent?: number; imageUrl?: string; expiresAt?: string }>;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

/**
 * Lenient read of the promo feature toggles (defaults: on, no pins).
 * settings.promos is historically an ARRAY of codes (promos.ts engine), so
 * the toggles are read from settings.promos when it is object-shaped
 * ({ codes: [...], showActive, ... }) and from settings.promoDisplay when
 * the array form is in use — either shape works.
 */
export function getPromoSpotSettings(settings: unknown): PromoSpotSettings {
  const root = (settings ?? null) as Record<string, unknown> | null;
  const promosRaw = root?.promos;
  const raw = (
    promosRaw && !Array.isArray(promosRaw) && typeof promosRaw === "object"
      ? promosRaw
      : (root?.promoDisplay ?? null)
  ) as Record<string, unknown> | null;
  const flashRaw = Array.isArray(raw?.flashOffers) ? raw.flashOffers : [];
  const flashOffers = flashRaw
    .map((f: any) => ({
      title: typeof f?.title === "string" ? f.title : "",
      discountPercent: Number.isFinite(Number(f?.discountPercent)) ? Number(f.discountPercent) : undefined,
      imageUrl: typeof f?.imageUrl === "string" ? f.imageUrl : undefined,
      expiresAt: typeof f?.expiresAt === "string" ? f.expiresAt : undefined,
    }))
    .filter((f) => f.title.length > 0);
  return {
    showActive: raw?.showActive !== false,
    spotlightProductIds: strArray(raw?.spotlightProductIds),
    featuredProductIds: strArray(raw?.featuredProductIds),
    flashOffers,
  };
}

// ── Active promotions ────────────────────────────────────────────────────────

/** Currently-valid + enabled promo codes (expiry, max-uses, enabled flag).
 *  Accepts both settings shapes (promos array, or promos object with codes). */
export function getActivePromos(settings: unknown, now: Date = new Date()): Promo[] {
  const nowMs = now.getTime();
  const root = (settings ?? null) as Record<string, unknown> | null;
  const effective =
    root?.promos && !Array.isArray(root.promos) && typeof root.promos === "object"
      ? { ...root, promos: (root.promos as Record<string, unknown>).codes }
      : settings;
  return getPromosFromSettings(effective).filter((p: any) => {
    if (p.enabled === false) return false;
    if (p.expiresAt && !Number.isNaN(Date.parse(p.expiresAt)) && Date.parse(p.expiresAt) <= nowMs) return false;
    if (typeof p.maxUses === "number" && (p.usedCount ?? 0) >= p.maxUses) return false;
    return true;
  });
}

export interface SpotlightPromo {
  kind: "promo" | "group_deal" | "flash";
  /** Card title line (e.g. "FLASH20" or the group-deal product name). */
  title: string;
  /** "20% off" / "₦500 off" / "Group deal". */
  discountText: string;
  /** Redeemable code when one exists. */
  code?: string;
  /** Optional card image override. */
  imageUrl?: string | null;
}

function discountTextFor(p: Promo): string {
  return p.type === "percent" ? `${Math.round(p.value)}% off` : `${p.value} off`;
}

/**
 * Spotlight candidates for a tenant: valid promo codes first (configured
 * order), then active group deals (deadline in the future), then unexpired
 * flash offers. Fail-open: group-deal lookup errors never block promo codes.
 */
export async function getSpotlightPromos(
  db: Db,
  tenantId: string,
  settings: unknown,
  now: Date = new Date(),
): Promise<SpotlightPromo[]> {
  const out: SpotlightPromo[] = [];
  for (const p of getActivePromos(settings, now)) {
    out.push({ kind: "promo", title: `Promo ${p.code}`, discountText: discountTextFor(p), code: p.code });
  }
  try {
    const { listGroupDealsTx } = await import("./groupBuy");
    const deals = await listGroupDealsTx(db, { tenantId, status: "active", limit: 5 }).catch(() => [] as any[]);
    const open = deals.length ? deals : await listGroupDealsTx(db, { tenantId, status: "open", limit: 5 }).catch(() => [] as any[]);
    for (const d of open) {
      const deadline = (d as any).deadline ? new Date((d as any).deadline) : null;
      if (deadline && deadline.getTime() <= now.getTime()) continue;
      out.push({
        kind: "group_deal",
        title: (d as any).title ?? (d as any).productName ?? "Group deal",
        discountText: "Group deal",
        imageUrl: (d as any).imageUrl ?? null,
      });
    }
  } catch { /* group deals are additive — fail open */ }
  const nowMs = now.getTime();
  for (const f of getPromoSpotSettings(settings).flashOffers) {
    if (f.expiresAt && !Number.isNaN(Date.parse(f.expiresAt)) && Date.parse(f.expiresAt) <= nowMs) continue;
    out.push({
      kind: "flash",
      title: f.title,
      discountText: f.discountPercent != null ? `${Math.round(f.discountPercent)}% off` : "Flash offer",
      imageUrl: f.imageUrl ?? null,
    });
  }
  return out;
}

// ── Most-ordered aggregation (90d, 5-min cache) ──────────────────────────────

export interface PopularProduct {
  productId: string;
  qty: number;
}

const POPULAR_TTL_MS = (() => {
  const raw = Number(process.env.PROMO_POPULAR_CACHE_TTL_MS ?? 300_000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(600_000, Math.max(10_000, raw)) : 300_000;
})();

const popularCache = new Map<string, { rows: PopularProduct[]; expiresAt: number }>();

/** Test hook: wipe the popular-products cache. */
export function __clearPopularProductsCache(): void {
  popularCache.clear();
}

/**
 * Most-ordered products for a tenant over the trailing 90 days: SUM(quantity)
 * per product across non-cancelled orders. Cached in-proc for 5 minutes
 * (waTenantLookup pattern) — a cache miss/error NEVER blocks the caller
 * (returns [] on DB failure).
 */
export async function getPopularProducts(
  db: Db,
  tenantId: string,
  limit = 10,
  now: Date = new Date(),
): Promise<PopularProduct[]> {
  const key = `${tenantId}:${limit}`;
  const hit = popularCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rows;
  try {
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        productId: orderItems.productId,
        qty: sql<number>`SUM(${orderItems.quantity})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(
        eq(orders.tenantId, tenantId),
        gte(orders.createdAt, since),
        sql`${orders.status} <> 'cancelled'`,
      ))
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`SUM(${orderItems.quantity})`))
      .limit(Math.min(Math.max(limit, 1), 50));
    popularCache.set(key, { rows, expiresAt: Date.now() + POPULAR_TTL_MS });
    return rows;
  } catch (e: any) {
    console.warn("[promoSpotlight] popular-products aggregation failed (fail-open):", e?.message);
    return [];
  }
}

/** Product ids ranked by sales (highest first). */
export async function getPopularProductIds(db: Db, tenantId: string, limit = 10): Promise<string[]> {
  return (await getPopularProducts(db, tenantId, limit)).map((r) => r.productId);
}

/** Top-N most-ordered product ids (for the "⭐ Most ordered" badge). */
export function topProductIds(popular: PopularProduct[], n = 3): Set<string> {
  return new Set(popular.slice(0, n).map((r) => r.productId));
}

/**
 * Display ranking: merchant featured pins first (in configured order), then
 * sales ranking, then the rest in their original order.
 */
export function rankForDisplay<T extends { id: string }>(
  items: T[],
  popularIds: string[],
  featuredIds: string[],
): T[] {
  if (!featuredIds.length && !popularIds.length) return items;
  const popularRank = new Map(popularIds.map((id, i) => [id, i]));
  const featuredRank = new Map(featuredIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const fa = featuredRank.get(a.id); const fb = featuredRank.get(b.id);
    if (fa != null || fb != null) {
      if (fa == null) return 1;
      if (fb == null) return -1;
      return fa - fb;
    }
    const pa = popularRank.get(a.id); const pb = popularRank.get(b.id);
    if (pa != null || pb != null) {
      if (pa == null) return 1;
      if (pb == null) return -1;
      return pa - pb;
    }
    return 0;
  });
}

// ── 30-minute per-session dedupe ─────────────────────────────────────────────

export const PROMO_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

/** True when a promo card was already shown in this session within 30 min. */
export function promoShownRecently(sessionCtx: Record<string, unknown> | null | undefined, now = Date.now()): boolean {
  const at = Number(sessionCtx?.promoShownAt ?? 0);
  return Number.isFinite(at) && at > 0 && now - at < PROMO_DEDUPE_WINDOW_MS;
}

// ── Channel renderers ────────────────────────────────────────────────────────

export const PROMO_CARD_SHOP_ID = "promo_shop";
export const PROMO_CARD_DEAL_PREFIX = "promo_deal:";
export const PROMO_CARD_POPULAR_ID = "promo_popular";

// === W52 SHARE === share-button id prefix lives in shareDeal.ts
// (PROMO_SHARE_PREFIX = "promo_share:") — imported lazily to keep the
// module graph acyclic.

/** Tenant settings for the card render: explicit opts.settings wins, else
 *  read the tenants row (needed for the W52 share link's merchant phone). */
async function resolveCardSettings(db: Db | null, tenantId: string, explicit: unknown): Promise<unknown> {
  if (explicit != null) return explicit;
  if (!db) return null;
  const [row] = await db.select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  return row?.settings ?? null;
}

/**
 * Card buttons honoring the channel button cap. Priority: Shop now →
 * View deal (code only) → Share (W52; code + merchant WA phone only) →
 * Popular items. On WhatsApp (cap 3) a shareable code lets the Share button
 * displace Popular-items (the "popular" keyword still works in text);
 * Telegram has no cap and keeps all four.
 */
async function buildPromoCardButtons(
  locale: Locale | string,
  promo: SpotlightPromo,
  settings: unknown,
  cap = 3,
): Promise<Array<{ id: string; title: string }>> {
  const shareable = promo.code
    ? (await import("./shareDeal")).buildDealShareBundle({ settings, promo, locale }) != null
    : false;
  const buttons = [
    { id: PROMO_CARD_SHOP_ID, title: t27(locale, "promoShopNow") },
    ...(promo.code ? [{ id: `${PROMO_CARD_DEAL_PREFIX}${promo.code}`, title: t27(locale, "promoViewDeal") }] : []),
    ...(shareable ? [{ id: `promo_share:${promo.code}`, title: t27(locale, "shareButtonLabel") }] : []),
    { id: PROMO_CARD_POPULAR_ID, title: t27(locale, "popularMenuLabel") },
  ];
  return buttons.slice(0, cap);
}

/** Localized card body: "🔥 {title} — {discount} with code {code}". */
export function renderPromoBody(locale: Locale | string, promo: SpotlightPromo): string {
  return t27(locale, "promoSpotlightBody", {
    title: promo.title,
    discount: promo.discountText,
    code: promo.code ?? "",
  }).replace(/\s+with code\s*$/i, "").trim();
}

/** USSD/SMS one-liner: "DEAL: {title} — {discount}. Use code {code}". */
export function renderPromoLine(locale: Locale | string, promo: SpotlightPromo): string {
  return t27(locale, "promoLine", {
    title: promo.title,
    discount: promo.discountText,
    code: promo.code ?? "",
  }).replace(/\s*Use code\s*$/i, "").trim();
}

/** USSD/SMS popular-items numbered text list (locale-aware header). */
export function renderPopularList(
  locale: Locale | string,
  items: Array<{ name: string; priceText: string }>,
): string {
  const header = t27(locale, "popularHeader");
  if (!items.length) return `${header}\n${t27(locale, "popularEmpty")}`;
  const lines = items.map((p, i) => `${i + 1}. ${p.name} — ${p.priceText}`);
  return `${header}\n${lines.join("\n")}`;
}

/** Card image: promo override → curated spotlight product → tenant logo. */
async function resolvePromoImage(
  db: Db,
  tenantId: string,
  promo: SpotlightPromo,
  spot: PromoSpotSettings,
): Promise<string | null> {
  if (promo.imageUrl) return promo.imageUrl;
  for (const pid of spot.spotlightProductIds) {
    const [row] = await db
      .select({ imageUrl: products.imageUrl })
      .from(products)
      .where(and(eq(products.id, pid), eq(products.tenantId, tenantId)))
      .limit(1)
      .catch(() => [] as any[]);
    if (row?.imageUrl) return row.imageUrl;
  }
  try {
    const { resolveTenantLogoUrl } = await import("./richMedia");
    return await resolveTenantLogoUrl(db, tenantId);
  } catch {
    return null;
  }
}

/**
 * WhatsApp spotlight card: ONE interactive — image header (promo image /
 * curated product image / tenant logo, else text header) + localized body +
 * [Shop now][View deal][Popular items] reply buttons. Fail-open.
 */
export async function sendWhatsAppPromoCard(
  tenantId: string,
  toPhone: string,
  promo: SpotlightPromo,
  opts: { locale?: Locale | string; settings?: unknown } = {},
): Promise<void> {
  const { sendWhatsAppInteractive } = await import("./waSender");
  const { publicMediaUrl } = await import("./richMedia");
  const locale = opts.locale ?? "en";
  const db = (await (await import("../db")).getDb()) as Db | null;
  const spot = getPromoSpotSettings(opts.settings);
  const image = db ? await resolvePromoImage(db, tenantId, promo, spot) : (promo.imageUrl ?? null);
  const link = publicMediaUrl(image);
  let headerImage: { link: string } | { mediaId: string } | null = null;
  if (link) {
    const { getOrUploadWaMediaId } = await import("./waMediaCache");
    const mediaId = await getOrUploadWaMediaId(tenantId, link).catch(() => null);
    headerImage = mediaId ? { mediaId } : { link };
  }
  // === W52 SHARE === shared button builder (3-button cap; 📤 Share joins
  // when the promo is code-backed and the tenant has a public WA phone).
  const cardSettings = await resolveCardSettings(db, tenantId, opts.settings);
  const buttons = (await buildPromoCardButtons(locale, promo, cardSettings))
    .map((b) => ({ id: b.id, title: b.title.slice(0, 20) }));
  await sendWhatsAppInteractive(tenantId, toPhone, {
    ...(headerImage ? { headerImage } : { headerText: promo.title }),
    bodyText: renderPromoBody(locale, promo),
    action: { type: "button", buttons },
  }, { notifType: "promo_spotlight" });
}

/**
 * Telegram parity: ONE sendPhoto (caption + inline keyboard) or a keyboard
 * message when no usable image exists. Fail-open.
 */
export async function sendTelegramPromoCard(
  tenantId: string,
  chatId: string,
  promo: SpotlightPromo,
  opts: { locale?: Locale | string; settings?: unknown } = {},
): Promise<void> {
  const { sendTelegramMedia, sendTelegramKeyboard } = await import("./telegramSender");
  const { publicMediaUrl } = await import("./richMedia");
  const locale = opts.locale ?? "en";
  const db = (await (await import("../db")).getDb()) as Db | null;
  const spot = getPromoSpotSettings(opts.settings);
  const image = db ? await resolvePromoImage(db, tenantId, promo, spot) : (promo.imageUrl ?? null);
  const link = publicMediaUrl(image);
  const body = renderPromoBody(locale, promo);
  // === W52 SHARE === same builder as the WA card, but TG has no button
  // cap — the keyboard keeps Shop/Deal/Share/Popular (keyboard parity).
  const cardSettings = await resolveCardSettings(db, tenantId, opts.settings);
  const buttons = await buildPromoCardButtons(locale, promo, cardSettings, 4);
  if (link) {
    await sendTelegramMedia(tenantId, chatId, {
      type: "photo",
      url: link,
      caption: body,
    }, { notifType: "promo_spotlight", replyMarkup: buttons });
  } else {
    await sendTelegramKeyboard(tenantId, chatId, body, buttons, { notifType: "promo_spotlight" });
  }
}

// ── Popular browse mode (shared by all channels) ─────────────────────────────

export interface PopularBrowseResult {
  reply: string;
  browseProducts?: Array<{ id: string; name: string; priceText: string; imageUrl: string | null }>;
}

/**
 * "Popular items" browse mode: catalog sorted featured-pins → sales ranking,
 * rendered as a localized numbered text list (USSD/SMS read the reply; WA/TG
 * additionally get the browseProducts annotation for product_list/album).
 */
export async function buildPopularBrowseResult(
  db: Db,
  args: { tenantId: string; locale?: Locale | string; limit?: number },
): Promise<PopularBrowseResult> {
  const locale = args.locale ?? "en";
  const limit = Math.min(Math.max(args.limit ?? 6, 1), 10);
  const [popular, tenantRow, rows] = await Promise.all([
    getPopularProducts(db, args.tenantId, 10),
    db.select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, args.tenantId))
      .limit(1).catch(() => [] as any[]),
    db.select({
      id: products.id, name: products.name, price: products.price,
      currency: products.currency, imageUrl: products.imageUrl,
    }).from(products)
      .where(and(eq(products.tenantId, args.tenantId), eq(products.status, "active")))
      .limit(100)
      .catch(() => [] as any[]),
  ]);
  if (!rows.length) {
    return { reply: `${t27(locale, "popularHeader")}\n${t27(locale, "popularEmpty")}` };
  }
  const spot = getPromoSpotSettings(tenantRow?.[0]?.settings ?? null);
  // === W51 MERGER FIX === the catalog read above is LIMIT 100 for
  // bounding; top sellers / merchant pins can live beyond that arbitrary
  // cut in large catalogs (and in the shared long-lived sim tenant). Pull
  // any ranked/pinned ids missing from the window so popularity + pins are
  // never silently dropped.
  const wanted = [...spot.featuredProductIds, ...popular.map((r) => r.productId)];
  const missing = wanted.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    const extra = await db.select({
      id: products.id, name: products.name, price: products.price,
      currency: products.currency, imageUrl: products.imageUrl,
    }).from(products)
      .where(and(eq(products.tenantId, args.tenantId), eq(products.status, "active"), inArray(products.id, missing)))
      .catch(() => [] as any[]);
    rows.push(...extra);
  }
  // === END W51 MERGER FIX ===
  const ranked = rankForDisplay(rows as Array<{ id: string } & any>, popular.map((r) => r.productId), spot.featuredProductIds)
    .slice(0, limit);
  const top3 = topProductIds(popular);
  const items = ranked.map((p: any) => ({
    id: p.id as string,
    name: top3.has(p.id) ? `⭐ ${p.name}` : (p.name as string),
    priceText: `${p.currency} ${p.price}`,
    imageUrl: (p.imageUrl as string | null) ?? null,
  }));
  return {
    reply: renderPopularList(locale, items),
    browseProducts: items,
  };
}
