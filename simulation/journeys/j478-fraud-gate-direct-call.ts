// === W48 integrations ===
/**
 * J478 — PERF-INT-3: the order-create fraud gate no longer does a
 * synchronous self-HTTP loopback with no timeout.
 *
 * Design choice (documented in server/routers/nlp.ts): the gate now calls
 * the shared in-process scorer `predictMlScore` DIRECTLY (the same function
 * the /api/ml/predict route serves). The ml-stack probe is bounded at 800ms
 * (INTEGRATION_TIMEOUTS.fraudGate); on timeout/error the in-process
 * statistical heuristic scores the order — bounded fail-open.
 *
 * Asserts:
 *   1. Source: no localhost:/api/ml/predict loopback remains in nlp.ts; the
 *      HTTP route delegates to the shared module (single source of truth).
 *   2. Behavior: predictMlScore returns a real verdict from the in-process
 *      heuristic when the ml-stack is unreachable — fast and non-throwing.
 *   3. Behavior: high-risk inputs still block (risk contract preserved).
 */
import { readFile } from "node:fs/promises";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J478",
  name: "fraud gate: in-process scorer, 800ms bounded, fail-open",
  feature: "PERF-INT-3",
  async run(_world: World) {
    const nlpSrc = await readFile(new URL("../../server/routers/nlp.ts", import.meta.url), "utf8");
    assert(!nlpSrc.includes("localhost:${process.env.PORT"), "no self-HTTP loopback in the order-create fraud gate");
    assert(!/fetch\([^\n]*\/api\/ml\/predict/.test(nlpSrc), "nlp.ts never fetches /api/ml/predict");
    assert(nlpSrc.includes("predictMlScore"), "fraud gate calls the in-process scorer");
    assert(nlpSrc.includes("INTEGRATION_TIMEOUTS.fraudGate"), "fraud gate bounded at 800ms");

    const idxSrc = await readFile(new URL("../../server/_core/index.ts", import.meta.url), "utf8");
    const routeIdx = idxSrc.indexOf('"/api/ml/predict"');
    assert(routeIdx > 0, "ml predict route still exists");
    assert(idxSrc.includes('await import("../services/mlPredict")'), "HTTP route delegates to the shared scorer");

    const { predictMlScore, INTEGRATION_TIMEOUTS } = await import("../../server/services/mlPredict");
    assert(INTEGRATION_TIMEOUTS.fraudGate <= 800, `fraud-gate budget ≤800ms (got ${INTEGRATION_TIMEOUTS.fraudGate})`);

    // ml-stack unreachable → in-process heuristic, fast, never throws.
    const prevUrl = process.env.ML_STACK_URL;
    process.env.ML_STACK_URL = "http://127.0.0.1:9"; // connection refused
    try {
      const t0 = Date.now();
      const low = await predictMlScore(
        { tenantId: "sim-tenant", amount: 500, phone: "+2348000000001", items: [{ productId: "p1", qty: 1 }], customerId: "+2348000000001" },
        { mlTimeoutMs: INTEGRATION_TIMEOUTS.fraudGate },
      );
      const elapsed = Date.now() - t0;
      assert(low.source === "fallback-heuristic", `unreachable ml-stack falls back in-process (got ${low.source})`);
      assert(low.riskLevel === "low", `small known-customer order scores low (got ${low.riskLevel})`);
      assert(elapsed < 2000, `bounded fail-open is fast (${elapsed}ms)`);

      // Risk contract preserved: large anonymous order → high risk (blocks).
      const high = await predictMlScore(
        { tenantId: "sim-tenant", amount: 600_000, phone: null, items: [{ productId: "p1", qty: 1 }], customerId: null },
        { mlTimeoutMs: INTEGRATION_TIMEOUTS.fraudGate },
      );
      assert(high.riskLevel === "high" && high.fraudProbability > 0.7, `high-risk input still scores high (got ${high.riskLevel}/${high.fraudProbability})`);
    } finally {
      if (prevUrl === undefined) delete process.env.ML_STACK_URL;
      else process.env.ML_STACK_URL = prevUrl;
    }
  },
};
