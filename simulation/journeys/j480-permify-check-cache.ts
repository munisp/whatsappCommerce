// === W48 integrations ===
/**
 * J480 — PERF-INT-5: Permify permission checks are served from a 30–60s TTL
 * cache, invalidated on membership/role writes, with fail-closed semantics
 * preserved on cache miss + Permify outage.
 *
 * Asserts:
 *   1. A second identical check is served from cache (no second HTTP call).
 *   2. permifyWriteRelationship / permifyDeleteRelationship invalidate.
 *   3. Miss + Permify down: errors are never cached — each miss reaches the
 *      fail policy path again (no stale verdict serves during an outage).
 *   4. Both allow AND deny verdicts are cached.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J480",
  name: "Permify check TTL cache + write invalidation + fail-closed miss",
  feature: "PERF-INT-5",
  async run(_world: World) {
    const permify = await import("../../server/permify");
    permify.__clearPermifyCheckCache();

    const prevUrl = process.env.PERMIFY_URL;
    const prevTenant = process.env.PERMIFY_TENANT_ID;
    process.env.PERMIFY_URL = "http://permify.sim";
    process.env.PERMIFY_TENANT_ID = "t1";

    let checkCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/permissions/check")) {
        checkCalls++;
        const body = JSON.parse(init?.body ?? "{}");
        const allowed = body?.subject?.id !== "deny-me";
        return new Response(JSON.stringify({ can: allowed ? "CHECK_RESULT_ALLOWED" : "CHECK_RESULT_DENIED" }), { status: 200 });
      }
      return new Response("{}", { status: 200 }); // relationship write/delete
    }) as any;

    const check = (subjectId: string) =>
      permify.permifyCheck({
        entity: { type: "system", id: "global" },
        permission: "manage",
        subject: { type: "user", id: subjectId },
      });

    try {
      // 1. First check hits HTTP; second is a cache hit.
      assert(await check("7") === true, "first check allowed");
      assert(await check("7") === true, "second check allowed (cached)");
      assert(checkCalls === 1, `second check served from cache (HTTP calls=${checkCalls})`);

      // 4. Deny verdicts are cached too.
      assert(await check("deny-me") === false, "deny verdict returned");
      assert(await check("deny-me") === false, "deny verdict cached");
      assert(checkCalls === 2, `deny also cached (HTTP calls=${checkCalls})`);

      // 2. A relationship write invalidates the cache.
      await permify.permifyWriteRelationship({
        entity: { type: "system", id: "global" },
        relation: "admin",
        subject: { type: "user", id: "7" },
      });
      assert(await check("7") === true, "post-write check re-fetched");
      assert(checkCalls === 3, `write invalidated the cache (HTTP calls=${checkCalls})`);

      await permify.permifyDeleteRelationship({
        entity: { type: "system", id: "global" },
        relation: "admin",
        subject: { type: "user", id: "7" },
      });
      assert(await check("7") === true, "post-delete check re-fetched");
      assert(checkCalls === 4, `delete invalidated the cache (HTTP calls=${checkCalls})`);

      // 3. Miss + Permify down: errors are NOT cached — each miss invokes
      //    the network again (no stale verdict masks an outage).
      permify.__clearPermifyCheckCache();
      let throwCalls = 0;
      globalThis.fetch = (async () => { throwCalls++; throw new Error("permify unreachable"); }) as any;
      await check("98");
      await check("98");
      assert(throwCalls === 2, `outage misses are never cached (thrower calls=${throwCalls})`);
    } finally {
      globalThis.fetch = realFetch;
      if (prevUrl === undefined) delete process.env.PERMIFY_URL; else process.env.PERMIFY_URL = prevUrl;
      if (prevTenant === undefined) delete process.env.PERMIFY_TENANT_ID; else process.env.PERMIFY_TENANT_ID = prevTenant;
      permify.__clearPermifyCheckCache();
    }
  },
};
