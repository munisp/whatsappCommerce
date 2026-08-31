/**
 * === W35 infra-receivers (Coder D) ===
 * J230 — infra otel-stack probes return honest DOWN when the stack is absent.
 *
 *  1. With fetch stubbed to REJECT (simulating no otel-collector/jaeger/
 *     prometheus/grafana/alertmanager), collectOtelStackStatuses() returns
 *     all 5 components {online:false} with an error string — never throws,
 *     never reports up.
 *  2. With fetch stubbed to SUCCEED (HTTP 200), the same probes report
 *     online:true with a latency — proving the probe isn't hard-coded down.
 *  3. collectInfraComponentStatuses() includes the 5 new components alongside
 *     the W34 15 (list honestly extended to 20).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J230",
  name: "otel-stack probes: honest down on absent stack, up on 200",
  feature: "W35 infra-receivers: infraHealth otel-stack probes",
  async run(_world: World) {
    const infra = await import("../../server/routers/infra");
    const realFetch = globalThis.fetch;

    // 1. Stack absent: every probe fails → honest down, no throw.
    globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as typeof fetch;
    let down: Record<string, { online: boolean; error?: string }>;
    try {
      down = await infra.collectOtelStackStatuses();
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const comp of ["otelCollector", "jaeger", "prometheus", "grafana", "alertmanager"]) {
      assert(comp in down, `probe ${comp} missing from result`);
      assert(down[comp].online === false, `${comp} must be honestly down when fetch rejects`);
      assert(typeof down[comp].error === "string" && down[comp].error!.length > 0, `${comp} must carry an error reason`);
    }

    // 2. Stack present (HTTP 200): probes report online — not hard-coded.
    globalThis.fetch = (() =>
      Promise.resolve(new Response("ok", { status: 200 }))) as typeof fetch;
    let up: Record<string, { online: boolean; latencyMs: number }>;
    try {
      up = await infra.collectOtelStackStatuses();
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const comp of ["otelCollector", "jaeger", "prometheus", "grafana", "alertmanager"]) {
      assert(up[comp].online === true, `${comp} must report online on HTTP 200`);
      assert(typeof up[comp].latencyMs === "number", `${comp} latency missing`);
    }

    // 3. Full component list extended honestly (15 W34 + 5 W35 = 20 keys).
    const all = await infra.collectInfraComponentStatuses();
    const keys = Object.keys(all);
    for (const comp of ["otelCollector", "jaeger", "prometheus", "grafana", "alertmanager"]) {
      assert(keys.includes(comp), `collectInfraComponentStatuses missing ${comp}`);
    }
    for (const comp of ["postgres", "redis", "kafka", "tigerBeetle", "reconWorker"]) {
      assert(keys.includes(comp), `W34 component ${comp} regressed`);
    }
    assert(keys.length === 20, `expected 20 components, got ${keys.length}: ${keys.join(",")}`);
  },
};
