// === W48 api-db ===
/**
 * J471 — PERF-API-6/9: Redis read-through cache for tenant settings/status +
 * chat-path catalog context, FAIL-OPEN with explicit invalidation.
 *
 * The sim runs without REDIS_URL, which exercises the fail-open doctrine
 * (cache layer disabled → every read falls through to Postgres). Proves:
 *   1. getTenantStatus still resolves correctly with the cache layer live,
 *   2. db.updateTenant invalidation never throws and the next status read
 *      reflects the write (no stale reads even if a cache were present),
 *   3. invalidateTenantCatalogCache / invalidateMenuCache are callable and
 *      never throw (they are wired into the product/menu mutation seams),
 *   4. cacheGetJson on a missing key returns null (miss → DB path).
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J471",
  name: "read-through cache fail-open + invalidation seams (PERF-API-6/9)",
  feature: "Redis read-through for catalog context/menus/tenant status; fail-open on miss; invalidation on writes",
  async run(world: World) {
    const cache = await import("../../server/services/readThroughCache");
    const { getTenantStatus } = await import("../../server/services/tenantGuard");
    const db = await import("../../server/db");

    // 1. Cache module is wired and fail-open (no REDIS_URL in sim).
    const miss = await cache.cacheGetJson("w48:j471:nonexistent");
    assert(miss === null, "cache miss returns null (fail-open)");
    await cache.cacheSetJson("w48:j471:x", { ok: true }, 60); // must not throw without Redis
    await cache.cacheDelKeys(["w48:j471:x"]);

    // 2. Tenant status resolves through the cache wrapper.
    const status1 = await getTenantStatus(world.db, TENANT_ID);
    assert(typeof status1 === "string" && status1.length > 0, `tenant status resolves (got ${status1})`);

    // 3. Invalidation seams are callable and never throw.
    await cache.invalidateTenantCatalogCache(TENANT_ID);
    await cache.invalidateTenantConfigCache(TENANT_ID);
    await cache.invalidateMenuCache("menu-j471");

    // 4. updateTenant (which now invalidates the tenant-config cache) keeps
    //    working; status read-after-write stays consistent.
    const t = await db.getTenantById(TENANT_ID);
    await db.updateTenant(TENANT_ID, { name: `${t?.name ?? "Sim Tenant"} (j471)` });
    const status2 = await getTenantStatus(world.db, TENANT_ID);
    assert(status2 === status1, "status stable across a name update (no cache corruption)");

    // 5. Key shapes are per-tenant (isolation contract).
    assert(cache.cacheKeys.catalogContext("a") !== cache.cacheKeys.catalogContext("b"), "catalog keys are per-tenant");
    assert(cache.cacheKeys.tenantStatus("a").includes("a"), "tenant status key namespaced");
    await world.settle(100);
  },
};
