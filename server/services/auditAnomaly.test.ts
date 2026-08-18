/**
 * W20 auditAnomaly unit tests — pure/deterministic seams that do not need a
 * database: threshold resolution, window bucketing, and the fail-open
 * contract (a throwing db handle must surface as a result, never an
 * exception). End-to-end behavior (baselines, alerts, idempotency, guards)
 * is covered by simulation journey J96.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  alertThreshold,
  windowBucketStart,
  scanAuditAnomaliesTx,
  DEFAULT_THRESHOLD,
  BASELINE_MIN_EVENTS,
} from "./auditAnomaly";

describe("auditAnomaly pure seams", () => {
  const prevEnv = process.env.AUDIT_ANOMALY_THRESHOLD;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AUDIT_ANOMALY_THRESHOLD;
    else process.env.AUDIT_ANOMALY_THRESHOLD = prevEnv;
  });

  it("alertThreshold: default, env override, explicit override, clamping", () => {
    delete process.env.AUDIT_ANOMALY_THRESHOLD;
    expect(alertThreshold()).toBe(DEFAULT_THRESHOLD);
    process.env.AUDIT_ANOMALY_THRESHOLD = "0.65";
    expect(alertThreshold()).toBe(0.65);
    expect(alertThreshold(0.9)).toBe(0.9); // explicit beats env
    expect(alertThreshold(1.7)).toBe(1); // clamped
    expect(alertThreshold(-0.2)).toBe(0);
    process.env.AUDIT_ANOMALY_THRESHOLD = "not-a-number";
    expect(alertThreshold()).toBe(DEFAULT_THRESHOLD); // bad env ignored
  });

  it("windowBucketStart floors to the window boundary", () => {
    const hour = 60 * 60 * 1000;
    const now = new Date(Date.UTC(2026, 0, 15, 3, 47, 12));
    expect(windowBucketStart(now, hour).toISOString()).toBe("2026-01-15T03:00:00.000Z");
    expect(windowBucketStart(now, 30 * 60 * 1000).toISOString()).toBe("2026-01-15T03:30:00.000Z");
  });

  it("exports the documented cold-start floor", () => {
    expect(BASELINE_MIN_EVENTS).toBe(20);
  });

  it("fail-open: a throwing db handle yields a result with error, never throws", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("db on fire");
      },
      insert: () => {
        throw new Error("db on fire");
      },
    };
    const res = await scanAuditAnomaliesTx(brokenDb as any, "tenant-x", { now: new Date() });
    expect(res.alertsCreated).toBe(0);
    expect(res.alerts).toEqual([]);
    expect(res.baselineBuilding).toBe(false);
    expect(res.error).toContain("db on fire");
  });

  it("cold start: empty tenant returns baselineBuilding with no alerts", async () => {
    // Minimal db stub: select → empty chainable result.
    const stubDb = {
      select: () => ({
        from: () => ({ where: async () => [] }),
      }),
      insert: () => {
        throw new Error("insert must not be called during cold start");
      },
    };
    const res = await scanAuditAnomaliesTx(stubDb as any, "tenant-empty", { now: new Date() });
    expect(res.baselineBuilding).toBe(true);
    expect(res.baselineEvents).toBe(0);
    expect(res.alertsCreated).toBe(0);
  });
});
