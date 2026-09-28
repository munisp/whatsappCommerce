// === W48 integrations ===
/**
 * J485 — PERF-INT-10 / PERF-INT-11 / PERF-INT-13: generic integration
 * circuit breaker semantics + the payment-chain overall deadline + moto
 * dispatch timeout hygiene.
 *
 * Asserts:
 *   1. The generic breaker trips after N consecutive failures, fails fast
 *      while open, and a successful half-open probe closes it again.
 *   2. initiateWithFallback honors a hard overall deadline: a slow first
 *      provider burns the budget and the chain aborts with
 *      ProviderChainExhaustedError (recorded as a "(deadline)" attempt)
 *      instead of hopping into another 10s probe cycle.
 *   3. motoDispatchStub routes through the bounded fetchJson helper.
 */
import { readFile } from "node:fs/promises";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J485",
  name: "generic circuit breaker + payment-chain deadline + moto timeout",
  feature: "PERF-INT-10 + PERF-INT-11 + PERF-INT-13",
  async run(world: World) {
    const rf = await import("../../server/services/net/resilientFetch");
    rf.__resetIntegrationBreakers();

    // ── 1. Breaker trip + half-open close ─────────────────────────────────
    const name = "j485-breaker";
    for (let i = 0; i < 4; i++) rf.recordIntegrationOutcome(name, false, { threshold: 5, cooldownMs: 60_000 });
    assert(rf.integrationBreakerState(name).open === false, "breaker closed below threshold");
    rf.recordIntegrationOutcome(name, false, { threshold: 5, cooldownMs: 60_000 });
    assert(rf.integrationBreakerState(name).open === true, "breaker open at threshold");
    const err = await (async () => { try { rf.assertCircuitClosed(name); return null; } catch (e: any) { return e; } })();
    assert(err instanceof rf.CircuitOpenError, "open circuit fails fast");
    rf.recordIntegrationOutcome(name, true);
    assert(rf.integrationBreakerState(name).open === false, "successful probe closes the breaker");

    // ── 2. Payment chain hard deadline (PERF-INT-11) ──────────────────────
    const registry = await import("../../server/services/payments/providers/registry");
    const { initiateWithFallback, ProviderChainExhaustedError } = await import("../../server/services/payments/initiateWithFallback");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slowProvider = (id: string) => ({
      id,
      displayName: id,
      async initiate(ctx: any) { await sleep(150); throw new Error(`${id} slow brownout`); },
      verifyWebhook: () => ({ ok: false as const, reference: "", amountCents: 0, metadata: {} }),
      async fetchStatus() { await sleep(150); return { status: "failed" as const, amountCents: 0 }; },
      testConnection: async () => ({ ok: true }),
    });
    registry.registerProvider(slowProvider("j485-slow-a") as any);
    registry.registerProvider(slowProvider("j485-slow-b") as any);
    const tenantId = crypto.randomUUID();
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: tenantId, name: "J485 Store", slug: `j485-${tenantId.slice(0, 8)}`, settings: {},
    } as any);
    await registry.upsertTenantProviderConfig({ tenantId, provider: "j485-slow-a", creds: { secretKey: "sk" }, priority: 10 });
    await registry.upsertTenantProviderConfig({ tenantId, provider: "j485-slow-b", creds: { secretKey: "sk" }, priority: 5 });

    const t0 = Date.now();
    const chainErr = await initiateWithFallback(tenantId, {
      tenantId,
      amountCents: 5000,
      currency: "NGN",
      reference: `j485-${tenantId.slice(0, 8)}`,
      metadata: {},
      customer: { phone: "+2348017000485" },
    } as any, { deadlineMs: 200 }).catch((e: any) => e);
    const elapsed = Date.now() - t0;
    assert(chainErr instanceof ProviderChainExhaustedError, `chain aborts with ProviderChainExhaustedError (got ${chainErr?.name ?? chainErr})`);
    assert(chainErr.attempts.some((a: any) => a.provider === "(deadline)"), "deadline abort recorded as an attempt");
    // Without the deadline this chain costs 2×(150 initiate + 150 probe);
    // with it, the second hop never starts.
    assert(elapsed < 450, `deadline bounded the chain (${elapsed}ms < 450ms)`);

    // ── 3. moto dispatch timeout hygiene (PERF-INT-13) ────────────────────
    const motoSrc = await readFile(new URL("../../server/services/delivery/motoDispatchStub.ts", import.meta.url), "utf8");
    assert(motoSrc.includes("fetchJson") && motoSrc.includes("INTEGRATION_TIMEOUTS"), "moto dispatch bounded via fetchJson");
    assert(!/await\s+fetch\(/.test(motoSrc), "no bare fetch in moto dispatch");
  },
};
