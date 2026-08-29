/**
 * === W34 otel-core ===
 * J215 — request → span with tenant.id baggage/attribute + x-trace-id header;
 *        /api/metrics increments.
 *
 * Runs the REAL telemetry stack (OTel SDK active, test-only in-memory span
 * ring instead of a collector — spans are produced by the real tracer):
 *   1. Authenticated HTTP tRPC query returns 200 with a 32-hex x-trace-id.
 *   2. A span `trpc.auth.me` exists carrying tenant.id from the AUTHENTICATED
 *      session (never request params) and shares the request trace id; an
 *      `http GET /api/trpc/...` server span exists for the same trace.
 *   3. /api/metrics (METRICS_TOKEN bearer) serves Prometheus text, and the
 *      http_requests_total + trpc_procedure_calls_total counters increment
 *      after the request. Tenant label honors the allowlist (tenant_class).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

const TID = "j215-tenant";
const METRICS_TOKEN = "j215-metrics-token";

function sumCounter(text: string, name: string): number {
  let sum = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith(`${name}{`)) {
      const v = Number(line.slice(line.lastIndexOf("}") + 1).trim());
      if (Number.isFinite(v)) sum += v;
    }
  }
  return sum;
}

export const journey: Journey = {
  id: "J215",
  name: "OTel span w/ tenant.id baggage + x-trace-id + metrics increments",
  feature: "W34 otel-core: core instrumentation + RED metrics endpoint",
  async run(world: World) {
    const telemetry = await import("../../server/_core/telemetry");
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "inmemory";
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    process.env.OTEL_TENANT_METRIC_ALLOWLIST = TID;
    await telemetry.initTelemetry();
    assert(telemetry.isTelemetryActive(), "telemetry did not activate with OTEL_ENABLED=true");
    telemetry.clearRecordedSpans();

    // Seed tenant + authenticated user (lazy imports per doctrine).
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J215 Telemetry", slug: TID, status: "active", createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const openId = "j215-user";
    await world.db.insert(schema.users).values({
      openId, name: "J215 User", tenantId: TID, lastSignedIn: now,
    }).onConflictDoNothing();
    const { signSessionToken } = await import("../../server/_core/auth");
    const token = signSessionToken({
      id: "21501", openId, email: null, name: "J215 User",
      role: "user", tenantId: TID, loginMethod: "keycloak",
    });

    const metricsReq = () =>
      fetch(`${world.baseUrl}/api/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });

    const m0 = await metricsReq();
    assert(m0.status === 200, `/api/metrics expected 200 with METRICS_TOKEN (got ${m0.status})`);
    const text0 = await m0.text();
    const httpBefore = sumCounter(text0, "http_requests_total");
    const trpcBefore = sumCounter(text0, "trpc_procedure_calls_total");

    // Unauthenticated /api/metrics is refused.
    const mAnon = await fetch(`${world.baseUrl}/api/metrics`);
    assert(mAnon.status === 401, `/api/metrics without auth must 401 (got ${mAnon.status})`);

    // ── Authenticated tRPC query over HTTP ───────────────────────────────
    const input = encodeURIComponent(JSON.stringify({ "0": { json: null, meta: { values: ["undefined"] } } }));
    const res = await fetch(`${world.baseUrl}/api/trpc/auth.me?batch=1&input=${input}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    assert(res.status === 200, `auth.me expected 200 (got ${res.status}: ${body.slice(0, 200)})`);
    const traceId = res.headers.get("x-trace-id");
    assert(!!traceId && /^[0-9a-f]{32}$/.test(traceId), `x-trace-id header missing/invalid (got ${traceId})`);

    // ── Span assertions ──────────────────────────────────────────────────
    const spans = telemetry.getRecordedSpans();
    const trpcSpan = spans.find((s) => s.name === "trpc.auth.me" && s.traceId === traceId);
    assert(!!trpcSpan, `no trpc.auth.me span for request trace (spans: ${spans.map((s) => s.name).join(",") || "none"})`);
    assert(
      trpcSpan!.attributes["tenant.id"] === TID,
      `trpc span missing tenant.id=${TID} baggage attribute (got ${JSON.stringify(trpcSpan!.attributes)})`,
    );
    const httpSpan = spans.find((s) => s.traceId === traceId && s.name.startsWith("http GET"));
    assert(!!httpSpan, "no http server span sharing the request trace id");

    // ── Metrics incremented ──────────────────────────────────────────────
    const m1 = await metricsReq();
    const text1 = await m1.text();
    assert(m1.status === 200, `/api/metrics second scrape failed (${m1.status})`);
    assert(text1.includes("trpc_procedure_calls_total"), "trpc_procedure_calls_total missing from exposition");
    assert(text1.includes("http_requests_total"), "http_requests_total missing from exposition");
    const httpAfter = sumCounter(text1, "http_requests_total");
    const trpcAfter = sumCounter(text1, "trpc_procedure_calls_total");
    assert(httpAfter > httpBefore, `http_requests_total did not increment (${httpBefore} → ${httpAfter})`);
    assert(trpcAfter > trpcBefore, `trpc_procedure_calls_total did not increment (${trpcBefore} → ${trpcAfter})`);
    // Allowlisted tenant keeps its id as the tenant_class label.
    assert(
      text1.includes(`tenant_class="${TID}"`),
      `allowlisted tenant label tenant_class="${TID}" missing from exposition`,
    );
    // infra_component_up gauge is fed by the reused infra probes.
    assert(text1.includes("infra_component_up{"), "infra_component_up gauge missing from exposition");

    const st = telemetry.telemetryStatus();
    assert(st.enabled && st.started, "telemetryStatus reports disabled/unfinished while active");
    assert(st.serviceName === "whatsapp-commerce-platform", "wrong service.name in telemetryStatus");
  },
};
