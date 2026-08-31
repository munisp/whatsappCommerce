/**
 * === W34 otel-core ===
 * Unit tests for server/_core/telemetry.ts — default-off behavior, tenant
 * cardinality guard, fail-open init, honest status, scheduler traceparent.
 * (Journey-level span/propagation assertions live in J215-J217.)
 */
import { describe, it, expect, afterEach } from "vitest";

const ENV_KEYS = [
  "OTEL_ENABLED", "OTEL_TRACES_EXPORTER", "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_TENANT_METRIC_ALLOWLIST", "METRICS_TOKEN", "TRACEPARENT",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("telemetry module", () => {
  it("is inert by default (OTEL_ENABLED unset)", async () => {
    delete process.env.OTEL_ENABLED;
    const t = await import("./_core/telemetry");
    await t.initTelemetry();
    expect(t.isTelemetryActive()).toBe(false);
    const st = t.telemetryStatus();
    expect(st.enabled).toBe(false);
    expect(st.started).toBe(false);
    expect(st.lastError).toBeNull();
  });

  it("tenantMetricClass bounds cardinality (allowlist / other / all)", async () => {
    const t = await import("./_core/telemetry");
    delete process.env.OTEL_TENANT_METRIC_ALLOWLIST;
    expect(t.tenantMetricClass("tenant-x")).toBe("all"); // empty allowlist = aggregate only
    process.env.OTEL_TENANT_METRIC_ALLOWLIST = "tenant-a, tenant-b";
    expect(t.tenantMetricClass("tenant-a")).toBe("tenant-a");
    expect(t.tenantMetricClass("tenant-b")).toBe("tenant-b");
    expect(t.tenantMetricClass("tenant-z")).toBe("other");
    expect(t.tenantMetricClass(null)).toBe("other");
  });

  it("injectTraceHeaders is a no-op when telemetry is off (fail-open)", async () => {
    delete process.env.OTEL_ENABLED;
    const t = await import("./_core/telemetry");
    await t.initTelemetry();
    const headers = { "content-type": "application/json" };
    const out = t.injectTraceHeaders({ ...headers });
    expect(out).toEqual(headers);
  });

  it("activates in in-memory exporter mode and reports status honestly", async () => {
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_TRACES_EXPORTER = "inmemory";
    const t = await import("./_core/telemetry");
    await t.initTelemetry();
    expect(t.isTelemetryActive()).toBe(true);
    const st = t.telemetryStatus();
    expect(st.enabled).toBe(true);
    expect(st.serviceName).toBe("whatsapp-commerce-platform");
    expect(st.exporterEndpoint).toBe("http://otel-collector:4318"); // default
    // cleanup: back to default-off so other tests are unaffected
    process.env.OTEL_ENABLED = "false";
    await t.initTelemetry();
    expect(t.isTelemetryActive()).toBe(false);
  }, 30000);

  it("prom registry exposes the W34 metric families", async () => {
    const t = await import("./_core/telemetry");
    const text = await t.renderMetrics();
    for (const name of [
      "http_requests_total", "http_request_duration_ms",
      "trpc_procedure_calls_total", "trpc_procedure_duration_ms",
      "escrow_settlements_total", "payout_latency_ms",
      "cron_runs_total", "infra_component_up", "telemetry_errors_total",
    ]) {
      expect(text).toContain(`# HELP ${name}`);
    }
  });
});

describe("scheduler OTel-lite traceparent injector", () => {
  it("mints a valid fresh root traceparent and reuses TRACEPARENT env trace id", async () => {
    const scheduler = await import("../services/scheduler/scheduler.mjs");
    delete process.env.TRACEPARENT;
    const a = scheduler.makeTraceparent();
    expect(a).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const b = scheduler.makeTraceparent();
    expect(b).not.toBe(a);
    process.env.TRACEPARENT = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    const c = scheduler.makeTraceparent();
    expect(c.split("-")[1]).toBe("cccccccccccccccccccccccccccccccc");
    expect(c.split("-")[2]).not.toBe("dddddddddddddddd");
    delete process.env.TRACEPARENT;
  });
});
