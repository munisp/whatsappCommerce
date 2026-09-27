// === W48 integrations ===
/**
 * J477 — PERF-INT-2: legacy PSP adapters in paymentGateway.ts are bounded.
 *
 * Was: bare fetch with NO timeout/retry/circuit on paystack/flutterwave/
 * mojaloop initiate+verify — a hung PSP connection pinned the user-facing
 * verify mutation indefinitely.
 *
 * Asserts:
 *   1. Source: legacy adapters route through resilientFetch with the 10s PSP
 *      timeout; no bare fetch remains in paymentGateway.ts.
 *   2. Behavior: fetchJson aborts a hung PSP call at the configured timeout
 *      (IntegrationTimeoutError, fast).
 *   3. Behavior: the per-integration circuit breaker opens after consecutive
 *      failures and subsequent calls fail FAST (CircuitOpenError).
 */
import { readFile } from "node:fs/promises";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J477",
  name: "PSP legacy adapters: timeout + bounded retry + circuit breaker",
  feature: "PERF-INT-2",
  async run(_world: World) {
    const src = await readFile(new URL("../../server/routers/paymentGateway.ts", import.meta.url), "utf8");
    assert(!/await\s+fetch\(/.test(src), "no bare fetch remains in paymentGateway.ts");
    assert(src.includes('from "../services/net/resilientFetch"'), "legacy adapters use resilientFetch");
    assert(src.includes("INTEGRATION_TIMEOUTS.psp"), "PSP 10s timeout budget applied");
    assert(src.includes('integration: "paystack"') && src.includes('integration: "flutterwave"'), "per-provider breakers named");
    assert(src.includes("retries: 1"), "idempotent verify GETs get one bounded retry");

    const rf = await import("../../server/services/net/resilientFetch");
    rf.__resetIntegrationBreakers();

    // ── Hung PSP connection aborts at the timeout ─────────────────────────
    const realFetch = globalThis.fetch;
    // W48 merger fix: a "hung connection" still honors the AbortSignal —
    // real fetch REJECTS with AbortError when resilientFetch's timeout aborts;
    // a never-settling promise deadlocks the journey (D's env never ran this).
    globalThis.fetch = ((_url: any, init: any) => new Promise<Response>((_res, rej) => {
      const sig = init?.signal;
      if (sig?.aborted) return rej(new DOMException("The operation was aborted", "AbortError"));
      sig?.addEventListener("abort", () => rej(new DOMException("The operation was aborted", "AbortError")));
    })) as any; // hangs until aborted
    try {
      const t0 = Date.now();
      const err = await rf.fetchJson("https://api.paystack.co/transaction/verify/XYZ", {
        integration: "j477-paystack",
        timeoutMs: 150,
      }).catch((e: any) => e);
      const elapsed = Date.now() - t0;
      assert(err instanceof rf.IntegrationTimeoutError, `hung call surfaces IntegrationTimeoutError (got ${err?.name ?? err})`);
      assert(elapsed < 2000, `timeout is prompt (elapsed ${elapsed}ms)`);

      // ── Circuit breaker trips after consecutive failures, then fails fast ──
      for (let i = 0; i < 5; i++) {
        await rf.fetchJson("https://api.flutterwave.com/v3/transactions/1/verify", {
          integration: "j477-flw",
          timeoutMs: 50,
        }).catch(() => {});
      }
      const state = rf.integrationBreakerState("j477-flw");
      assert(state.open, `breaker open after 5 consecutive timeouts (failures=${state.consecutiveFailures})`);
      const t1 = Date.now();
      const fastErr = await rf.fetchJson("https://api.flutterwave.com/v3/transactions/1/verify", {
        integration: "j477-flw",
        timeoutMs: 50,
      }).catch((e: any) => e);
      const fastElapsed = Date.now() - t1;
      assert(fastErr instanceof rf.CircuitOpenError, "open circuit fails fast with CircuitOpenError");
      assert(fastElapsed < 100, `fast-fail is immediate (${fastElapsed}ms, no timeout burn)`);
    } finally {
      globalThis.fetch = realFetch;
      rf.__resetIntegrationBreakers();
    }
  },
};
