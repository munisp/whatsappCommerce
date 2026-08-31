/**
 * === W34 otel-sidecars (Coder C) — cardinality guard unit tests (no DB) ===
 * tenantMetricClass collapse semantics + env CSV parsing + fail-open status.
 */
import { describe, expect, it } from "vitest";
import {
  TENANT_CLASS_OTHER,
  envAllowlist,
  getTelemetryStatus,
  tenantMetricClass,
} from "./telemetryCardinality";

describe("W34 telemetryCardinality", () => {
  it("allowlisted tenant keeps its id; others collapse to 'other'", () => {
    const allowlist = ["tenant-a", "tenant-b"];
    expect(tenantMetricClass("tenant-a", allowlist)).toBe("tenant-a");
    expect(tenantMetricClass("tenant-b", allowlist)).toBe("tenant-b");
    expect(tenantMetricClass("tenant-c", allowlist)).toBe(TENANT_CLASS_OTHER);
    expect(tenantMetricClass("tenant-z", allowlist)).toBe(TENANT_CLASS_OTHER);
  });

  it("empty allowlist = platform-aggregate only (everything 'other')", () => {
    expect(tenantMetricClass("tenant-a", [])).toBe(TENANT_CLASS_OTHER);
  });

  it("null/undefined tenant collapses to 'other'", () => {
    expect(tenantMetricClass(null, ["tenant-a"])).toBe(TENANT_CLASS_OTHER);
    expect(tenantMetricClass(undefined, ["tenant-a"])).toBe(TENANT_CLASS_OTHER);
  });

  it("label cardinality stays ≤ allowlist + 1 under many tenants", () => {
    const allowlist = ["t1", "t2"];
    const labels = new Set<string>();
    for (let i = 0; i < 1_000; i++) labels.add(tenantMetricClass(`t${i}`, allowlist));
    expect(labels.size).toBeLessThanOrEqual(allowlist.length + 1);
    expect(labels.has(TENANT_CLASS_OTHER)).toBe(true);
  });

  it("env CSV parsing: trims, drops empties, empty = none", () => {
    expect(envAllowlist({ OTEL_TENANT_METRIC_ALLOWLIST: " a , b ,,c " } as any)).toEqual(["a", "b", "c"]);
    expect(envAllowlist({} as any)).toEqual([]);
    expect(envAllowlist({ OTEL_TENANT_METRIC_ALLOWLIST: "" } as any)).toEqual([]);
  });

  it("getTelemetryStatus is fail-open with OTEL disabled by default", async () => {
    const saved = process.env.OTEL_ENABLED;
    delete process.env.OTEL_ENABLED;
    try {
      const st = await getTelemetryStatus(null);
      expect(st.enabled).toBe(false);
      expect(st.exporter.configured).toBe(false);
      expect(st.exporter.endpoint).toBeNull();
      expect(st.exporter.reachable).toBeNull();
      expect(st.allowlist.effectiveCount).toBe(0);
    } finally {
      if (saved !== undefined) process.env.OTEL_ENABLED = saved;
    }
  });

  it("getTelemetryStatus reports unreachable collector honestly (fail-open)", async () => {
    const savedEnabled = process.env.OTEL_ENABLED;
    const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_ENABLED = "true";
    // Port 1 is never listening — the probe must report reachable=false,
    // not throw.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
    try {
      const st = await getTelemetryStatus(null);
      expect(st.enabled).toBe(true);
      expect(st.exporter.endpoint).toBe("http://127.0.0.1:1");
      expect(st.exporter.reachable).toBe(false);
      expect(st.exporter.lastError).toBeTruthy();
    } finally {
      if (savedEnabled === undefined) delete process.env.OTEL_ENABLED;
      else process.env.OTEL_ENABLED = savedEnabled;
      if (savedEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedEndpoint;
    }
  });
});
// === END W34 otel-sidecars ===
