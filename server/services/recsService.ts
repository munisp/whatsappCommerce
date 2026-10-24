// === W64 intelligence (R1) ===
/**
 * Co-purchase recommendations wired out of the ml-stack /recommend stub.
 *
 *   - refreshCoPurchasePairs: rebuilds the `copurchase_pairs` table from
 *     order_items co-occurrence (two order lines in the SAME order, both
 *     directions). Claim-style refresh: delete+insert per tenant inside one
 *     code path; idempotent and safe to re-run (nightly sweep +
 *     /api/scheduled/recs-refresh).
 *   - getCoPurchaseForProduct: "customers also bought…" for a product.
 *   - getReorderSuggestionsForBuyer: personalized reorder suggestions from
 *     the buyer's OWN order history (frequency-ranked).
 *   - getPostPurchaseRecs: union of co-purchase pairs for an order's lines
 *     (used by post-purchase follow-ups).
 *
 * All reads are fail-open (telemetry, never money-path): any DB/Redis error
 * returns []. Results are cached briefly in Redis (in-process Map fallback).
 * Prices are integer cents only at boundaries; product `price` stays the
 * catalog decimal string (existing convention).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { copurchasePairs, orderItems, orders, products } from "../../drizzle/schema";
import { getRedis } from "../redis";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface RecItem {
  productId: string;
  name: string;
  /** Decimal string catalog price (existing products.price convention). */
  price: string;
  currency: string;
  imageUrl: string | null;
  /** Co-purchase count or own-purchase frequency (ranking signal). */
  score: number;
}

const CACHE_TTL_SECONDS = 300; // 5 min read cache; the table is the truth.
const memoryCache = new Map<string, { at: number; value: RecItem[] }>();

/** Test hook: clear the in-process read cache. */
export function resetRecsCacheForTests(): void {
  memoryCache.clear();
}

async function cached(key: string, load: () => Promise<RecItem[]>): Promise<RecItem[]> {
  try {
    const redis = await getRedis();
    if (redis) {
      const hit = await redis.get(key).catch(() => null);
      if (hit) return JSON.parse(hit) as RecItem[];
      const value = await load();
      await redis.set(key, JSON.stringify(value), "EX", CACHE_TTL_SECONDS).catch(() => {});
      return value;
    }
  } catch { /* Redis outage → in-process fallback */ }
  const now = Date.now();
  const hit = memoryCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_SECONDS * 1000) return hit.value;
  const value = await load();
  memoryCache.set(key, { at: now, value });
  return value;
}

/**
 * Rebuild co-purchase pairs for one tenant (or all tenants when omitted).
 * Delete + re-insert from a 180-day order_items self-join; both directions
 * are stored so lookups key on product_id only.
 */
export async function refreshCoPurchasePairs(db: Db, tenantId?: string): Promise<{ tenants: number; pairs: number }> {
  // Tenant scope list (bounded: tenants with any order_items in the window).
  const scope = tenantId
    ? [{ tenantId }]
    : await db.execute(sql`
        SELECT DISTINCT o."tenantId" AS "tenantId"
        FROM order_items a JOIN orders o ON o.id = a."orderId"
        WHERE o."createdAt" > now() - interval '180 days'
      `).then((r: any) => (r.rows ?? r) as Array<{ tenantId: string }>).catch(() => [] as Array<{ tenantId: string }>);
  let pairs = 0;
  // PGlite: strictly sequential statements (no Promise.all on the same conn).
  for (const t of scope) {
    await db.delete(copurchasePairs).where(eq(copurchasePairs.tenantId, t.tenantId));
    const inserted = await db.execute(sql`
      INSERT INTO copurchase_pairs (tenant_id, product_id, pair_product_id, co_count, updated_at)
      SELECT * FROM (
        SELECT o."tenantId", a."productId", b."productId", COUNT(DISTINCT a."orderId")::int AS co_count, now()
        FROM order_items a
        JOIN order_items b ON a."orderId" = b."orderId" AND a."productId" <> b."productId"
        JOIN orders o ON o.id = a."orderId"
        WHERE o."tenantId" = ${t.tenantId}
          AND o.status NOT IN ('cancelled')
          AND o."createdAt" > now() - interval '180 days'
        GROUP BY o."tenantId", a."productId", b."productId"
      ) x WHERE co_count > 0
      ON CONFLICT (tenant_id, product_id, pair_product_id)
      DO UPDATE SET co_count = EXCLUDED.co_count, updated_at = now()
    `).catch((e: any) => {
      console.warn("[recs] pair refresh failed (fail-open):", e?.message);
      return null;
    });
    // PGlite execute does not expose a reliable rowCount for
    // INSERT ... SELECT ... ON CONFLICT — count the tenant's rows directly.
    if (inserted !== null) {
      const counted = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM copurchase_pairs WHERE tenant_id = ${t.tenantId}
      `).then((r: any) => (r.rows ?? r)).catch(() => [] as any[]);
      pairs += Number((counted as any[])[0]?.n ?? 0) || 0;
    }
  }
  return { tenants: scope.length, pairs };
}

/** "Customers who bought X also bought…" — refreshed table + product join. */
export async function getCoPurchaseForProduct(
  db: Db,
  tenantId: string,
  productId: string,
  limit = 4,
): Promise<RecItem[]> {
  return cached(`recs:co:${tenantId}:${productId}:${limit}`, async () => {
    try {
      const rows = await db
        .select({
          productId: copurchasePairs.pairProductId,
          score: copurchasePairs.coCount,
          name: products.name,
          price: products.price,
          currency: products.currency,
          imageUrl: products.imageUrl,
        })
        .from(copurchasePairs)
        .innerJoin(products, eq(products.id, copurchasePairs.pairProductId))
        .where(and(
          eq(copurchasePairs.tenantId, tenantId),
          eq(copurchasePairs.productId, productId),
          eq(products.status, "active"),
        ))
        .orderBy(desc(copurchasePairs.coCount))
        .limit(limit);
      return rows;
    } catch (e: any) {
      console.warn("[recs] co-purchase lookup failed (fail-open):", e?.message);
      return [];
    }
  });
}

/** Personalized reorder suggestions from the buyer's own order history. */
export async function getReorderSuggestionsForBuyer(
  db: Db,
  tenantId: string,
  customerId: string,
  limit = 4,
): Promise<RecItem[]> {
  return cached(`recs:reorder:${tenantId}:${customerId}:${limit}`, async () => {
    try {
      const rows = await db
        .select({
          productId: orderItems.productId,
          score: sql<number>`count(*)::int`,
          name: products.name,
          price: products.price,
          currency: products.currency,
          imageUrl: products.imageUrl,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .innerJoin(products, eq(products.id, orderItems.productId))
        .where(and(
          eq(orders.tenantId, tenantId),
          eq(orders.customerId, customerId),
          eq(products.status, "active"),
        ))
        .groupBy(orderItems.productId, products.name, products.price, products.currency, products.imageUrl)
        .orderBy(desc(sql`count(*)`))
        .limit(limit);
      return rows;
    } catch (e: any) {
      console.warn("[recs] reorder lookup failed (fail-open):", e?.message);
      return [];
    }
  });
}

/** Post-purchase "also bought" recs for the lines of one order. */
export async function getPostPurchaseRecs(
  db: Db,
  tenantId: string,
  orderId: string,
  limit = 4,
): Promise<RecItem[]> {
  try {
    const lines = await db
      .select({ productId: orderItems.productId })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .limit(20);
    if (!lines.length) return [];
    const seen = new Set(lines.map((l) => l.productId));
    const rows = await db
      .select({
        productId: copurchasePairs.pairProductId,
        score: sql<number>`sum(${copurchasePairs.coCount})::int`,
        name: products.name,
        price: products.price,
        currency: products.currency,
        imageUrl: products.imageUrl,
      })
      .from(copurchasePairs)
      .innerJoin(products, eq(products.id, copurchasePairs.pairProductId))
      .where(and(
        eq(copurchasePairs.tenantId, tenantId),
        inArray(copurchasePairs.productId, lines.map((l) => l.productId)),
        eq(products.status, "active"),
      ))
      .groupBy(copurchasePairs.pairProductId, products.name, products.price, products.currency, products.imageUrl)
      .orderBy(desc(sql`sum(${copurchasePairs.coCount})`))
      .limit(limit + seen.size);
    return rows.filter((r) => !seen.has(r.productId)).slice(0, limit);
  } catch (e: any) {
    console.warn("[recs] post-purchase lookup failed (fail-open):", e?.message);
    return [];
  }
}
// === END W64 intelligence (R1) ===
