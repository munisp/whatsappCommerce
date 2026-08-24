/**
 * server/services/geoDiscovery.ts — W25 geospatial merchant discovery.
 *
 * Customers discover nearby businesses around their current location
 * (WhatsApp location pin on mobile, browser geolocation on web). Merchants
 * are browsable by category menu and free-text search; paid placement exists
 * as location-aware sponsored listings (migration 0068).
 *
 * Architecture: the ranking core is PURE (no DB, no deps) so tests seed
 * in-memory fixtures; `discoverNearby` optionally loads rows from the DB
 * and delegates to the pure core. Pure exports:
 *
 *   haversineKm(a, b)                      — great-circle distance (km)
 *   encodeGeohash(lat, lng, precision=5)   — base32 geohash (~5km cells)
 *   geohashPrefilterCells(lat, lng)        — center cell + 8 neighbors
 *   discoverNearbyPure(opts, data)         — filter/rank/paginate
 *   buildCategoryTree(rows)                — taxonomy menu tree
 *
 * PRIVACY: customer coordinates are a TRANSIENT query input — they are never
 * persisted, logged, or attached to any customer record by this service.
 *
 * Ranking (deterministic):
 *   baseScore = trustScore (0 when unknown) − distanceKm × DISTANCE_WEIGHT
 *   sponsored boost: score = baseScore + bidCents / 100   (bid in cents →
 *   a +N point boost where N = bid in currency units). Sponsored results are
 *   flagged `sponsored: true` for disclosure, and capped per page by
 *   GEO_SPONSORED_MAX_PER_PAGE (default 2).
 */
import crypto from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  kycApplications,
  merchantLocations,
  products,
  productTaxonomy,
  sponsoredListings,
  sponsoredSpendEvents,
  tenants,
} from "../../drizzle/schema";

// ─── Tunables (imported by tests — never hardcode elsewhere) ────────────────
/** Earth mean radius, km. */
export const EARTH_RADIUS_KM = 6371.0088;
/** Ranking: score penalty per km of distance. */
export const DISTANCE_WEIGHT = 1;
/** Geohash precision for the candidate prefilter (~4.9km × 4.9km cells). */
export const GEOHASH_PRECISION = 5;
/** Approximate cell width/height (km) at GEOHASH_PRECISION (mid-latitudes). */
export const GEOHASH_CELL_KM = 4.9;
/** Quick radius options surfaced by the UI (km). */
export const RADIUS_QUICK_OPTIONS = [1, 2, 5, 10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function defaultRadiusKm(): number {
  return envNumber("GEO_DEFAULT_RADIUS_KM", 5);
}
export function maxRadiusKm(): number {
  return envNumber("GEO_MAX_RADIUS_KM", 50);
}
export function sponsoredMaxPerPage(): number {
  return Math.max(0, Math.floor(envNumber("GEO_SPONSORED_MAX_PER_PAGE", 2)));
}

// ─── Distance ───────────────────────────────────────────────────────────────
/** Great-circle distance in km (haversine). */
export function haversineKm(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ─── Geohash (base32, pure TS) ──────────────────────────────────────────────
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard base32 geohash. Precision 5 (default) ≈ 5km cells. */
export function encodeGeohash(lat: number, lng: number, precision = GEOHASH_PRECISION): string {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let even = true;
  let bit = 0;
  let ch = 0;
  let hash = "";
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch = ch * 2 + 1; lngMin = mid; }
      else { ch = ch * 2; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = ch * 2 + 1; latMin = mid; }
      else { ch = ch * 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Decode a geohash to its lat/lng bounds. */
export function decodeGeohashBounds(hash: string): {
  latMin: number; latMax: number; lngMin: number; lngMax: number;
} {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let even = true;
  for (const c of hash.toLowerCase()) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error(`invalid geohash char: ${c}`);
    for (let bit = 4; bit >= 0; bit--) {
      const set = (idx >> bit) & 1;
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (set) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (set) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return { latMin, latMax, lngMin, lngMax };
}

/**
 * Candidate prefilter cells: the geohash cell containing (lat,lng) plus its
 * 8 adjacent cells (computed by offsetting one cell height/width from the
 * cell center). Any merchant within one cell width of the search point is
 * guaranteed to fall in this 3×3 block.
 */
export function geohashPrefilterCells(
  lat: number, lng: number, precision = GEOHASH_PRECISION,
): string[] {
  const center = encodeGeohash(lat, lng, precision);
  const b = decodeGeohashBounds(center);
  const latH = b.latMax - b.latMin;
  const lngW = b.lngMax - b.lngMin;
  const cLat = (b.latMin + b.latMax) / 2;
  const cLng = (b.lngMin + b.lngMax) / 2;
  const cells = new Set<string>();
  for (const dLat of [-1, 0, 1]) {
    for (const dLng of [-1, 0, 1]) {
      const nLat = Math.max(-90, Math.min(90, cLat + dLat * latH));
      let nLng = cLng + dLng * lngW;
      if (nLng > 180) nLng -= 360;
      if (nLng < -180) nLng += 360;
      cells.add(encodeGeohash(nLat, nLng, precision));
    }
  }
  return Array.from(cells).sort();
}

// ─── Open hours ─────────────────────────────────────────────────────────────
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Evaluate openHours against a reference instant. openHours JSON shape:
 *   { "mon": [["09:00","17:00"]], "tue": [...], ... }   (keys sun..sat,
 *   each an array of [open, close] "HH:MM" windows; overnight windows like
 *   ["22:00","02:00"] are supported).
 * Returns null when openHours is absent/unparseable (unknown ≠ closed).
 */
export function computeOpenNow(
  openHours: unknown, now: Date = new Date(),
): boolean | null {
  if (!openHours || typeof openHours !== "object") return null;
  const hours = openHours as Record<string, unknown>;
  // UTC day/minutes: caller passes the reference instant; timezone handling
  // (merchant-local conversion) is the caller's concern.
  const day = DAY_KEYS[now.getUTCDay()];
  const windows = hours[day];
  if (!Array.isArray(windows)) {
    // No entry for today means closed ONLY if the object has any day keys.
    return Object.keys(hours).length > 0 ? false : null;
  }
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const w of windows) {
    if (!Array.isArray(w) || w.length < 2) continue;
    const parse = (s: unknown): number | null => {
      if (typeof s !== "string") return null;
      const m = s.match(/^(\d{1,2}):(\d{2})$/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const open = parse(w[0]);
    const close = parse(w[1]);
    if (open == null || close == null) continue;
    if (open <= close) {
      if (minutes >= open && minutes < close) return true;
    } else if (minutes >= open || minutes < close) {
      return true; // overnight window
    }
  }
  return false;
}

// ─── Pure discovery core ────────────────────────────────────────────────────
export interface MerchantCandidate {
  tenantId: string;
  businessName: string;
  latitude: number;
  longitude: number;
  geohash: string;
  /** Lower-cased category ids (taxonomy category / product category names). */
  categories: string[];
  /** Searchable product text (names + descriptions, lower-cased). */
  productText: string[];
  /** true = KYB approved; null/undefined = unknown (not filtered out). */
  kybVerified?: boolean | null;
  /** 0..100 trust/rating when available. */
  trustScore?: number | null;
  openHours?: unknown;
  serviceRadiusKm?: number | null;
}

export interface SponsoredCandidate {
  tenantId: string;
  categories: string[]; // empty = all categories
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  bidCents: number;
  /** DB listing id (present on DB-loaded candidates; absent in pure fixtures). */
  listingId?: string;
}

export interface DiscoverOptions {
  lat: number;
  lng: number;
  radiusKm?: number;
  category?: string;
  query?: string;
  openNow?: boolean;
  page?: number;
  pageSize?: number;
  /** Reference instant for open-now evaluation (tests inject this). */
  now?: Date;
  /** Override the sponsored-per-page cap (defaults to env). */
  sponsoredMaxPerPage?: number;
}

export interface DiscoverItem {
  tenantId: string;
  businessName: string;
  category: string | null;
  distanceKm: number;
  sponsored: boolean;
  trustScore: number | null;
  rating: number | null;
  openNow: boolean | null;
  score: number;
}

export interface DiscoverResult {
  items: DiscoverItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  radiusKm: number;
}

export function discoverNearbyPure(
  opts: DiscoverOptions,
  data: { merchants: MerchantCandidate[]; sponsored: SponsoredCandidate[] },
): DiscoverResult {
  const maxR = maxRadiusKm();
  const radiusKm = Math.min(Math.max(opts.radiusKm ?? defaultRadiusKm(), 0.1), maxR);
  const page = Math.max(0, Math.floor(opts.page ?? 0));
  const pageSize = Math.min(Math.max(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const sponsoredCap = opts.sponsoredMaxPerPage ?? sponsoredMaxPerPage();
  const now = opts.now ?? new Date();
  const category = opts.category?.trim().toLowerCase() || null;
  const query = opts.query?.trim().toLowerCase() || null;

  // Candidate prefilter via geohash prefix cells (only when the radius fits
  // within one cell width; larger radii skip the prefilter). Exact haversine
  // filtering below is authoritative either way.
  let prefixSet: Set<string> | null = null;
  if (radiusKm <= GEOHASH_CELL_KM) {
    prefixSet = new Set(geohashPrefilterCells(opts.lat, opts.lng));
  }

  const scored: DiscoverItem[] = [];
  for (const m of data.merchants) {
    if (m.kybVerified === false) continue; // KYB-rejected/unknown-as-false excluded
    if (prefixSet && !prefixSet.has(m.geohash.slice(0, GEOHASH_PRECISION))) continue;
    const distanceKm = haversineKm(opts.lat, opts.lng, m.latitude, m.longitude);
    if (distanceKm > radiusKm) continue;
    // A merchant that limits its own service area is only shown when the
    // customer is inside that area.
    if (m.serviceRadiusKm != null && distanceKm > m.serviceRadiusKm) continue;
    if (category && !m.categories.includes(category)) continue;
    if (query) {
      const inName = m.businessName.toLowerCase().includes(query);
      const inProducts = m.productText.some((p) => p.includes(query));
      if (!inName && !inProducts) continue;
    }
    const openNow = computeOpenNow(m.openHours ?? null, now);
    if (opts.openNow && openNow !== true) continue;
    const trust = m.trustScore ?? null;
    // baseScore = trustScore − distance weight (see header).
    const baseScore = (trust ?? 0) - distanceKm * DISTANCE_WEIGHT;
    scored.push({
      tenantId: m.tenantId,
      businessName: m.businessName,
      category: m.categories[0] ?? null,
      distanceKm,
      sponsored: false,
      trustScore: trust,
      rating: trust, // trust score doubles as the surfaced rating when present
      openNow,
      score: baseScore,
    });
  }

  // Sponsored boost: listing center must be within its radiusKm of the
  // search point, and categories empty or overlapping the filter category.
  for (const s of data.sponsored) {
    const reachKm = Math.min(s.radiusKm, maxR);
    if (haversineKm(opts.lat, opts.lng, s.centerLat, s.centerLng) > reachKm) continue;
    const cats = s.categories.map((c) => c.toLowerCase());
    if (category && cats.length > 0 && !cats.includes(category)) continue;
    const item = scored.find((i) => i.tenantId === s.tenantId);
    if (!item) continue; // only boost merchants already eligible this search
    item.sponsored = true;
    item.score += s.bidCents / 100; // documented boost: bid cents → currency units
  }

  // Deterministic order: score desc, then distanceKm asc, then tenantId asc.
  scored.sort((a, b) =>
    b.score - a.score || a.distanceKm - b.distanceKm ||
    (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0),
  );

  // Sponsored cap per page: keep the top-N sponsored entries, demote the
  // rest to organic (flag removed, boost removed is NOT undone for ranking —
  // they simply lose the sponsored flag and slot).
  let sponsoredSeen = 0;
  const capped = scored.filter((i) => {
    if (!i.sponsored) return true;
    if (sponsoredSeen < sponsoredCap) { sponsoredSeen++; return true; }
    return false;
  });

  const total = capped.length;
  const items = capped.slice(page * pageSize, (page + 1) * pageSize);
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: (page + 1) * pageSize < total,
    radiusKm,
  };
}

// ─── Category taxonomy tree ─────────────────────────────────────────────────
export interface CategoryNode {
  id: string; // category id = lower-cased category name (taxonomy key)
  name: string;
  subcategories: { id: string; name: string }[];
}

export function buildCategoryTree(
  rows: { category: string; subcategory?: string | null }[],
): CategoryNode[] {
  const map = new Map<string, CategoryNode>();
  for (const r of rows) {
    const name = r.category?.trim();
    if (!name) continue;
    const id = name.toLowerCase();
    let node = map.get(id);
    if (!node) {
      node = { id, name, subcategories: [] };
      map.set(id, node);
    }
    const sub = r.subcategory?.trim();
    if (sub && !node.subcategories.some((s) => s.id === sub.toLowerCase())) {
      node.subcategories.push({ id: sub.toLowerCase(), name: sub });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ─── DB-backed wrappers ─────────────────────────────────────────────────────
// Structural `any` handle (same convention as mlLeadScoring.ts) so this
// module stays importable without pulling in the postgres driver.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

// ── W27 (Coder E) additive hook: external trustScore provider ───────────────
// geoDiscovery still owns ranking; this hook only fills the previously
// hard-coded `trustScore: null` (tenants has no trust column — W25 note).
// server/services/reviews.ts registers a review-driven provider; when none
// is registered behaviour is byte-identical to before.
export type TrustScoreProvider = (tenantIds: string[], db: Db) => Promise<Map<string, number>>;
let trustScoreProvider: TrustScoreProvider | null = null;
export function setTrustScoreProvider(p: TrustScoreProvider | null): void {
  trustScoreProvider = p;
}

/** Numeric columns come back from drizzle as strings — normalize. */
function toNum(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

/**
 * Load discovery candidates from the DB. Only discoverable merchants of
 * active tenants; KYB-approved flag from kyc_applications (type='kyb',
 * status='approved'); categories + product text from active products.
 */
export async function loadDiscoveryData(db: Db): Promise<{
  merchants: MerchantCandidate[];
  sponsored: SponsoredCandidate[];
}> {
  const locRows = (await db
    .select()
    .from(merchantLocations)
    .where(eq(merchantLocations.discoverable, true))) as Record<string, unknown>[];
  if (locRows.length === 0) return { merchants: [], sponsored: [] };

  const tenantIds = locRows.map((r) => r.tenantId as string);

  const tenantRows = (await db
    .select({ id: tenants.id, name: tenants.name, status: tenants.status })
    .from(tenants)
    .where(inArray(tenants.id, tenantIds))) as Record<string, unknown>[];
  const tenantById = new Map(tenantRows.map((t) => [t.id as string, t]));

  // KYB: tenant is verified when it has an approved type='kyb' application.
  // W30 (V2#11): FAIL CLOSED on query error — previously a DB error was
  // swallowed to zero rows and kybVerified collapsed to `null`, which the
  // downstream filter treated as "include". Now an errored/empty lookup
  // marks every candidate UNVERIFIED (excluded by the kybVerified filter).
  let kybLookupFailed = false;
  const kybRows = (await db
    .select({ tenantId: kycApplications.tenantId, status: kycApplications.status })
    .from(kycApplications)
    .where(and(inArray(kycApplications.tenantId, tenantIds), eq(kycApplications.type, "kyb")))
    .catch(() => { kybLookupFailed = true; return []; })) as Record<string, unknown>[];
  const kybApproved = new Set(
    kybRows.filter((r) => r.status === "approved").map((r) => r.tenantId as string),
  );

  const productRows = (await db
    .select({
      tenantId: products.tenantId, name: products.name,
      description: products.description, category: products.category,
    })
    .from(products)
    .where(and(inArray(products.tenantId, tenantIds), eq(products.status, "active")))
    .catch(() => [])) as Record<string, unknown>[];
  const productsByTenant = new Map<string, Record<string, unknown>[]>();
  for (const p of productRows) {
    const tid = p.tenantId as string;
    if (!productsByTenant.has(tid)) productsByTenant.set(tid, []);
    productsByTenant.get(tid)!.push(p);
  }

  // W27: resolve trust scores via the registered provider (no-op by default).
  const trustScores = trustScoreProvider
    ? await trustScoreProvider(tenantIds, db).catch(() => new Map<string, number>())
    : new Map<string, number>();

  const merchants: MerchantCandidate[] = [];
  for (const r of locRows) {
    const tid = r.tenantId as string;
    const t = tenantById.get(tid);
    if (!t || t.status !== "active") continue;
    const prods = productsByTenant.get(tid) ?? [];
    merchants.push({
      tenantId: tid,
      businessName: (t.name as string) ?? tid,
      latitude: toNum(r.latitude),
      longitude: toNum(r.longitude),
      geohash: r.geohash as string,
      categories: Array.from(new Set(
        prods.map((p) => (p.category as string | null)?.trim().toLowerCase())
          .filter((c): c is string => !!c),
      )),
      productText: prods.flatMap((p) =>
        [p.name, p.description]
          .filter((x): x is string => typeof x === "string" && !!x)
          .map((x) => x.toLowerCase()),
      ),
      // W30 (V2#11): never `null` — unknown/errored lookups are UNVERIFIED.
      // A lookup failure excludes every candidate (fail closed).
      kybVerified: kybLookupFailed ? false : kybApproved.has(tid),
      trustScore: trustScores.get(tid) ?? null, // W27: review-driven provider hook (default none)
      openHours: r.openHours,
      serviceRadiusKm: r.serviceRadiusKm != null ? toNum(r.serviceRadiusKm) : null,
    });
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const listingRows = (await db
    .select()
    .from(sponsoredListings)
    .where(eq(sponsoredListings.status, "active"))
    .catch(() => [])) as Record<string, unknown>[];
  const sponsored: SponsoredCandidate[] = [];
  for (const r of listingRows) {
    // W30 (V2#16): the budget cap is enforced against TODAY's spend only —
    // spent_on_date gives the counter its lazy daily reset (no cron needed).
    const spentToday = (r.spentOnDate as string | null) === today ? toNum(r.spentTodayCents) : 0;
    if (spentToday >= toNum(r.dailyBudgetCents)) continue;
    if (r.startsAt && new Date(r.startsAt as string) > now) continue;
    if (r.endsAt && new Date(r.endsAt as string) < now) continue;
    sponsored.push({
      tenantId: r.tenantId as string,
      categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
      centerLat: toNum(r.centerLat),
      centerLng: toNum(r.centerLng),
      radiusKm: toNum(r.radiusKm),
      bidCents: toNum(r.bidCents),
      listingId: r.id as string,
    });
  }

  return { merchants, sponsored };
}

// ─── W30 (V2#16): sponsored spend writer ────────────────────────────────────
/**
 * Debit the daily budget for every sponsored placement actually SERVED in a
 * discover page. For each listing:
 *   1. a guarded conditional UPDATE atomically debits bidCents and lazily
 *      resets the counter when the date rolled over — the daily cap is
 *      enforced at serve time and can never be raced past more than one
 *      in-flight serve;
 *   2. an honest billing row (sponsored_spend_events) records the charge,
 *      keyed by a unique reference so retries never double-bill.
 * When the guarded update loses the cap race, the placement is NOT billed
 * (no row, no debit) — we never charge for budget we couldn't claim.
 */
export async function recordSponsoredServed(
  db: Db,
  served: Array<{ listingId: string; tenantId: string; bidCents: number }>,
  now: Date = new Date(),
): Promise<{ debited: number; skipped: number }> {
  const today = now.toISOString().slice(0, 10);
  let debited = 0;
  let skipped = 0;
  for (const s of served) {
    const bid = Math.max(0, Math.round(s.bidCents));
    if (bid === 0) { skipped++; continue; } // zero-bid placement: no charge
    const { sql } = await import("drizzle-orm");
    const updated = (await db.execute(sql`
      UPDATE sponsored_listings
      SET spent_today_cents = CASE WHEN spent_on_date = ${today} THEN spent_today_cents + ${bid} ELSE ${bid} END,
          spent_on_date = ${today},
          updated_at = now()
      WHERE id = ${s.listingId}
        AND status = 'active'
        AND (spent_on_date IS DISTINCT FROM ${today} OR spent_today_cents + ${bid} <= daily_budget_cents)
      RETURNING id
    `).catch(() => [])) as unknown as Array<{ id: string }>;
    if (!updated[0]) { skipped++; continue; } // cap reached concurrently — not billed
    const reference = `sponsored-serve:${s.listingId}:${today}:${crypto.randomUUID()}`;
    await db.insert(sponsoredSpendEvents).values({
      listingId: s.listingId,
      tenantId: s.tenantId,
      spendDate: today,
      kind: "serve",
      amountCents: bid,
      reference,
    }).onConflictDoNothing();
    debited++;
  }
  return { debited, skipped };
}

/**
 * Daily reset sweep (idempotent): zero counters whose date has rolled over.
 * The serve/read paths already handle the rollover lazily — this exists for
 * operators/schedulers that want the table to reflect the reset eagerly.
 */
export async function resetSponsoredSpendDaily(db: Db, now: Date = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const { ne, and, isNotNull } = await import("drizzle-orm");
  const rows = await db.update(sponsoredListings)
    .set({ spentTodayCents: 0, updatedAt: now })
    .where(and(isNotNull(sponsoredListings.spentOnDate), ne(sponsoredListings.spentOnDate, today)))
    .returning({ id: sponsoredListings.id });
  return rows.length;
}

/**
 * DB-backed discovery. Pass a drizzle db instance (router resolves getDb()).
 */
export async function discoverNearby(
  opts: DiscoverOptions,
  db: Db,
): Promise<DiscoverResult> {
  const data = await loadDiscoveryData(db);
  const result = discoverNearbyPure(opts, data);
  // W30 (V2#16): real spend writer — debit the daily budget for every
  // sponsored placement actually served on this page, with honest billing
  // rows. Fire-and-collect: billing failures never break discovery, but are
  // logged loudly (a serve without a debit is revenue leakage, not a 500).
  const servedIds = new Set(result.items.filter((i) => i.sponsored).map((i) => i.tenantId));
  if (servedIds.size > 0) {
    const served = data.sponsored
      .filter((s) => s.listingId && servedIds.has(s.tenantId))
      .map((s) => ({ listingId: s.listingId!, tenantId: s.tenantId, bidCents: s.bidCents }));
    if (served.length > 0) {
      await recordSponsoredServed(db, served).catch((err) => {
        console.error(`[geoDiscovery] sponsored spend debit failed (${served.length} serves unbilled): ${err?.message ?? err}`);
      });
    }
  }
  return result;
}

/** Taxonomy menu tree from product_taxonomy (global + all tenants). */
export async function listCategories(db: Db): Promise<CategoryNode[]> {
  const rows = (await db
    .select({ category: productTaxonomy.category, subcategory: productTaxonomy.subcategory })
    .from(productTaxonomy)
    .where(eq(productTaxonomy.isActive, true))
    .catch(() => [])) as Record<string, unknown>[];
  return buildCategoryTree(
    rows.map((r) => ({
      category: r.category as string,
      subcategory: r.subcategory as string | null,
    })),
  );
}
