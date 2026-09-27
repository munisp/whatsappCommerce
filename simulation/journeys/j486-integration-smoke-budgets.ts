// === W48 integrations ===
/**
 * J486 — W48 smoke budgets: journey-level timing assertions for the
 * integration paths fixed in this wave (docs/PERFORMANCE_BUDGETS.md).
 *
 * Budgets asserted (smoke-level, generous multipliers over the p95 contract
 * to stay stable under shared-CI vitest load):
 *   1. Fraud gate (order-create path): unreachable ml-stack → in-process
 *      fallback verdict in < 2s (contract: 800ms probe bound, PERF-INT-3).
 *   2. Cached tenant lookup: a warm cache hit resolves in < 50ms
 *      (PERF-INT-6 — the uncached Postgres select was per-message).
 *   3. Circuit-open PSP verify fails fast in < 50ms (PERF-INT-2/10 — no
 *      10s timeout burn while the breaker is open).
 *   4. Permify cached verdict serves in < 50ms (PERF-INT-5 — was a network
 *      RTT per admin request).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J486",
  name: "integration smoke budgets (fraud gate, tenant cache, breaker, permify cache)",
  feature: "PERF-INT-2/3/5/6 budgets",
  async run(world: World) {
    // ── 1. Fraud gate bound ───────────────────────────────────────────────
    const { predictMlScore, INTEGRATION_TIMEOUTS } = await import("../../server/services/mlPredict");
    const prevUrl = process.env.ML_STACK_URL;
    process.env.ML_STACK_URL = "http://127.0.0.1:9";
    try {
      const t0 = Date.now();
      const r = await predictMlScore(
        { tenantId: "sim-tenant", amount: 1200, phone: "+2348017000486", items: [{ productId: "p", qty: 1 }], customerId: "+2348017000486" },
        { mlTimeoutMs: INTEGRATION_TIMEOUTS.fraudGate },
      );
      const elapsed = Date.now() - t0;
      assert(r.fraudProbability > 0 && r.riskLevel.length > 0, "verdict returned");
      assert(elapsed < 2000, `SMOKE BUDGET: fraud gate < 2s (was ${elapsed}ms; contract 800ms probe bound)`);
    } finally {
      if (prevUrl === undefined) delete process.env.ML_STACK_URL; else process.env.ML_STACK_URL = prevUrl;
    }

    // ── 2. Warm tenant-lookup cache hit ───────────────────────────────────
    const wl = await import("../../server/services/waTenantLookup");
    wl.__clearWaTenantLookupCache();
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [simTenant] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, "sim-tenant")).limit(1);
    const pnId = (simTenant as any)?.whatsappPhoneNumberId as string | null;
    if (pnId) {
      await wl.lookupTenantByPhoneNumberId(world.db, pnId); // warm
      const t1 = Date.now();
      const hit = await wl.lookupTenantByPhoneNumberId(world.db, pnId);
      const hitMs = Date.now() - t1;
      assert(hit?.id === "sim-tenant", "warm lookup resolves the tenant");
      assert(hitMs < 50, `SMOKE BUDGET: cached tenant lookup < 50ms (was ${hitMs}ms)`);
    }

    // ── 3. Circuit-open PSP call fails fast ───────────────────────────────
    const rf = await import("../../server/services/net/resilientFetch");
    rf.__resetIntegrationBreakers();
    for (let i = 0; i < 5; i++) rf.recordIntegrationOutcome("j486-psp", false);
    const t2 = Date.now();
    const openErr = await rf.fetchJson("https://api.paystack.co/transaction/verify/X", {
      integration: "j486-psp",
      timeoutMs: 10_000,
    }).catch((e: any) => e);
    const openMs = Date.now() - t2;
    assert(openErr instanceof rf.CircuitOpenError, "open breaker short-circuits the call");
    assert(openMs < 50, `SMOKE BUDGET: circuit-open fast-fail < 50ms (was ${openMs}ms; would have burned 10s pre-W48)`);
    rf.__resetIntegrationBreakers();

    // ── 4. Permify cached verdict latency ─────────────────────────────────
    const permify = await import("../../server/permify");
    permify.__clearPermifyCheckCache();
    const prevPermify = process.env.PERMIFY_URL;
    process.env.PERMIFY_URL = "http://permify.sim";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ can: "CHECK_RESULT_ALLOWED" }), { status: 200 })) as any;
    try {
      const input = { entity: { type: "system", id: "global" }, permission: "manage", subject: { type: "user", id: "486" } };
      await permify.permifyCheck(input); // prime
      const t3 = Date.now();
      const allowed = await permify.permifyCheck(input);
      const permifyMs = Date.now() - t3;
      assert(allowed === true, "cached verdict served");
      assert(permifyMs < 50, `SMOKE BUDGET: cached Permify verdict < 50ms (was ${permifyMs}ms; was a network RTT per request)`);
    } finally {
      globalThis.fetch = realFetch;
      if (prevPermify === undefined) delete process.env.PERMIFY_URL; else process.env.PERMIFY_URL = prevPermify;
      permify.__clearPermifyCheckCache();
    }
  },
};
