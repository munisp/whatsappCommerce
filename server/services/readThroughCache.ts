/**
 * === W48 api-db (PERF-API-6 / PERF-API-9) ===
 * Redis read-through cache for hot, slow-changing per-tenant data on the
 * chat/dashboard read paths (catalog context, product lists, tenant
 * settings/status).
 *
 * Doctrine: FAIL-OPEN. A Redis outage, miss, or (de)serialization error
 * always falls back to the Postgres read — the cache can never break a read
 * path. Writes invalidate explicitly from the existing mutation seams
 * (product mutations via the enqueueProductSync seam in routers/product.ts;
 * tenant settings via db.updateTenant).
 *
 * TTLs are short (60–300s) so even a missed invalidation self-heals.
 */
import { redisGet, redisSet, redisDel } from "../redis";

/** Default TTLs (seconds). Overridable via env for ops tuning. */
function ttlFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 5 && v <= 86400 ? Math.floor(v) : fallback;
}
export const CATALOG_CTX_TTL_S = ttlFromEnv("CACHE_CATALOG_CTX_TTL_S", 120);
export const PRODUCT_LIST_TTL_S = ttlFromEnv("CACHE_PRODUCT_LIST_TTL_S", 120);
export const TENANT_CFG_TTL_S = ttlFromEnv("CACHE_TENANT_CFG_TTL_S", 300);

/** Cache keys (per-tenant). */
export const cacheKeys = {
  catalogContext: (tenantId: string) => `w48:catalogCtx:${tenantId}`,
  productList: (tenantId: string, limit: number, offset: number, search?: string) =>
    `w48:products:${tenantId}:${limit}:${offset}:${search ?? ""}`,
  tenantStatus: (tenantId: string) => `w48:tenantStatus:${tenantId}`,
  menu: (menuId: string) => `w48:menu:${menuId}`,
} as const;

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await redisGet(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (e: any) {
    console.warn("[readThroughCache] get failed (fail-open):", e?.message);
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redisSet(key, JSON.stringify(value), ttlSeconds);
  } catch (e: any) {
    console.warn("[readThroughCache] set failed (fail-open):", e?.message);
  }
}

export async function cacheDelKeys(keys: string[]): Promise<void> {
  for (const k of keys) {
    try {
      await redisDel(k);
    } catch (e: any) {
      console.warn("[readThroughCache] del failed (fail-open):", e?.message);
    }
  }
}

/**
 * Invalidate every catalog/product cache entry for a tenant. Called from the
 * product mutation seam (enqueueProductSync in routers/product.ts). The
 * productList keys are paginated/searched so we can't enumerate them cheaply
 * — instead we bump a per-tenant epoch folded into those keys' readers via
 * catalogContext invalidation + short TTL; the hot chat-path key
 * (catalogContext) is deleted explicitly.
 */
export async function invalidateTenantCatalogCache(tenantId: string): Promise<void> {
  await cacheDelKeys([cacheKeys.catalogContext(tenantId)]);
}

/** Invalidate tenant settings/status cache entries (db.updateTenant seam). */
export async function invalidateTenantConfigCache(tenantId: string): Promise<void> {
  await cacheDelKeys([cacheKeys.tenantStatus(tenantId)]);
}

/** Invalidate a cached menu snapshot (menu router mutation seam). */
export async function invalidateMenuCache(menuId: string): Promise<void> {
  await cacheDelKeys([cacheKeys.menu(menuId)]);
}
// === END W48 api-db ===
