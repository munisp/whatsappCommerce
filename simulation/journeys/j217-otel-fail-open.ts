/**
 * === W34 otel-core ===
 * J217 — telemetry fail-OPEN: OTEL_ENABLED=true with an UNREACHABLE collector.
 *
 *   1. SDK starts (OTLP exporter configured against a dead endpoint).
 *   2. Requests still succeed (cron route + tRPC procedure) — a collector
 *      outage NEVER breaks the request path.
 *   3. telemetryStatus() reports the failure HONESTLY (exporterReachable
 *      false, lastError set, exportFailures > 0) instead of claiming health.
 *   4. Cleanup: telemetry disabled again so later journeys see the default.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J217",
  name: "telemetry fail-open with unreachable collector + honest status",
  feature: "W34 otel-core: fail-open telemetry, honest telemetryStatus",
  async run(world: World) {
    const telemetry = await import("../../server/_core/telemetry");
    process.env.OTEL_ENABLED = "true";
    delete process.env.OTEL_TRACES_EXPORTER; // real OTLP HTTP exporter
    // 127.0.0.1:9 (discard) — nothing listens, every export fails fast.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "100";
    await telemetry.initTelemetry();

    try {
      const st0 = telemetry.telemetryStatus();
      assert(st0.enabled && st0.started, "SDK should start even with an unreachable collector");

      // ── Requests succeed despite the dead exporter ─────────────────────
      const cron = await world.runCron("/api/scheduled/sla-scan");
      assert(cron.status === 200, `cron route failed with dead collector (got ${cron.status})`);
      const caller = await tenantCaller("sim-tenant", { userId: 21701 });
      const me = await caller.auth.me();
      assert(!!me && (me as { tenantId?: string }).tenantId === "sim-tenant", "tRPC call failed with dead collector");

      // ── Honest exporter error reporting ────────────────────────────────
      await world.waitFor(() => {
        const st = telemetry.telemetryStatus();
        return st.exportFailures > 0 && st.exporterReachable === false && !!st.lastError;
      }, 60000, "exporter failure surfaced in telemetryStatus");
      const st = telemetry.telemetryStatus();
      assert(st.exporterReachable === false, "telemetryStatus must report exporter unreachable");
      assert(typeof st.lastError === "string" && st.lastError.length > 0, "telemetryStatus.lastError empty");
      assert(st.exportFailures > 0, "telemetryStatus.exportFailures not counted");
    } finally {
      // ── Cleanup: restore the default (telemetry OFF) for later journeys ──
      process.env.OTEL_ENABLED = "false";
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_BSP_SCHEDULE_DELAY;
      delete process.env.OTEL_METRICS_EXPORTER;
      delete process.env.METRICS_TOKEN;
      delete process.env.OTEL_TENANT_METRIC_ALLOWLIST;
      await telemetry.initTelemetry();
      assert(!telemetry.isTelemetryActive(), "telemetry did not shut down after OTEL_ENABLED=false");
      const off = await fetch(`${world.baseUrl}/api/metrics`).catch(() => null);
      if (off) assert(off.status === 503 || off.status === 401, `/api/metrics while disabled should be 503/401 (got ${off.status})`);
    }
  },
};
