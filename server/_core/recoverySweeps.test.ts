/**
 * Recovery sweeps runner tests (assurance F-02).
 *
 * Covers:
 *   - every sweep in the default plan is invoked against the db handle
 *   - per-sweep try/catch isolation: one throwing sweep does not stop others
 *   - structured result summary (ok flag, per-sweep outcomes, durations)
 *   - failures are reported to the observability sink as CRITICAL
 *   - idempotent double-run (claim-first sweeps are safe to re-run)
 *   - settlement_retry marker scan dedupes markers and calls retrySettlement
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/observability", () => ({
  captureException: vi.fn(),
}));

const retrySettlementMock = vi.fn();
const reconcileMock = vi.fn();
vi.mock("../services/tradeCredit/capture", () => ({
  retrySettlement: (...args: any[]) => retrySettlementMock(...args),
  reconcilePendingMandateCharges: (...args: any[]) => reconcileMock(...args),
}));
const bureauRetryMock = vi.fn();
vi.mock("../services/compliance/bureau", () => ({
  retryFailedReports: (...args: any[]) => bureauRetryMock(...args),
}));
const dunningMock = vi.fn();
vi.mock("../services/tradeCredit/dunning", () => ({
  runDunningCheckTx: (...args: any[]) => dunningMock(...args),
}));
const dedupeSweepMock = vi.fn();
vi.mock("../services/webhookDedupe", () => ({
  sweepProcessedWebhookEvents: (...args: any[]) => dedupeSweepMock(...args),
  WEBHOOK_DEDUPE_RETENTION_DAYS: 7,
}));

import { captureException } from "../services/observability";
import {
  runSweepPlan, buildDefaultSweepPlan, settlementRetryMarkerSweep,
  sweepEndpointAuth, sweepIntervalMinutes,
} from "./recoverySweeps";

describe("sweep endpoint auth gate", () => {
  it("is disabled (fail-closed) when SWEEP_SECRET is unset — never a default", () => {
    expect(sweepEndpointAuth({}, {})).toBe("disabled");
    expect(sweepEndpointAuth({ "x-sweep-secret": "anything" }, { SWEEP_SECRET: "  " })).toBe("disabled");
  });

  it("rejects missing or wrong secret (401 path)", () => {
    const env = { SWEEP_SECRET: "s3cr3t-value" };
    expect(sweepEndpointAuth({}, env)).toBe("unauthorized");
    expect(sweepEndpointAuth({ "x-sweep-secret": "wrong-secret" }, env)).toBe("unauthorized");
    expect(sweepEndpointAuth({ "x-sweep-secret": "s3cr3t-valu" }, env)).toBe("unauthorized");
  });

  it("accepts the exact shared secret", () => {
    expect(sweepEndpointAuth({ "x-sweep-secret": "s3cr3t-value" }, { SWEEP_SECRET: "s3cr3t-value" })).toBe("ok");
  });
});

describe("sweepIntervalMinutes", () => {
  it("is off by default and opt-in via a positive integer", () => {
    expect(sweepIntervalMinutes({})).toBeNull();
    expect(sweepIntervalMinutes({ SWEEP_INTERVAL_MINUTES: "" })).toBeNull();
    expect(sweepIntervalMinutes({ SWEEP_INTERVAL_MINUTES: "0" })).toBeNull();
    expect(sweepIntervalMinutes({ SWEEP_INTERVAL_MINUTES: "abc" })).toBeNull();
    expect(sweepIntervalMinutes({ SWEEP_INTERVAL_MINUTES: "-5" })).toBeNull();
    expect(sweepIntervalMinutes({ SWEEP_INTERVAL_MINUTES: "15" })).toBe(15);
  });
});

function markerScanDb(markers: Array<{ accountId: string; ref: string | null }>) {
  const limit = vi.fn().mockResolvedValue(markers);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSweepPlan", () => {
  it("runs every sweep and returns a structured summary", async () => {
    const plan = [
      { name: "a", run: vi.fn().mockResolvedValue({ did: 1 }) },
      { name: "b", run: vi.fn().mockResolvedValue({ did: 2 }) },
    ];
    const report = await runSweepPlan(plan);
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(plan[0].run).toHaveBeenCalledOnce();
    expect(plan[1].run).toHaveBeenCalledOnce();
    expect(report.results[0]).toMatchObject({ name: "a", ok: true, summary: { did: 1 } });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("one throwing sweep does not stop the others and is captured CRITICAL", async () => {
    const boom = new Error("sweep exploded");
    const plan = [
      { name: "bad", run: vi.fn().mockRejectedValue(boom) },
      { name: "good", run: vi.fn().mockResolvedValue({ ok: 1 }) },
    ];
    const report = await runSweepPlan(plan);
    expect(report.ok).toBe(false);
    expect(plan[1].run).toHaveBeenCalledOnce(); // isolation: still ran
    expect(report.results[0]).toMatchObject({ name: "bad", ok: false, error: "sweep exploded" });
    expect(report.results[1]).toMatchObject({ name: "good", ok: true });
    expect(captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ operation: "sweep:bad", severity: "critical" }),
    );
  });

  it("idempotent double-run: running the same plan twice invokes each sweep twice", async () => {
    const run = vi.fn().mockResolvedValue({ n: 1 });
    const plan = [{ name: "x", run }];
    await runSweepPlan(plan);
    const second = await runSweepPlan(plan);
    expect(run).toHaveBeenCalledTimes(2);
    expect(second.ok).toBe(true);
  });
});

describe("buildDefaultSweepPlan", () => {
  it("wires all five recovery sweeps to the db handle", async () => {
    retrySettlementMock.mockResolvedValue({ ok: true, status: "settled", reference: "r1" });
    reconcileMock.mockResolvedValue({ checked: 3, settled: 2, failed: 0, stillPending: 1 });
    bureauRetryMock.mockResolvedValue({ attempted: 4, sent: 3, failed: 1 });
    dunningMock.mockResolvedValue({ reminded: 1, feesApplied: 1, frozen: 0 });
    dedupeSweepMock.mockResolvedValue(9);

    const db = markerScanDb([
      { accountId: "acc1", ref: "ref-1" },
      { accountId: "acc1", ref: "ref-1" }, // duplicate marker row → one retry
      { accountId: "acc2", ref: "ref-2" },
    ]);
    const plan = buildDefaultSweepPlan(db, new Date("2026-01-01"));
    expect(plan.map((s) => s.name)).toEqual([
      "settlement-retry",
      "mandate-charge-reconcile",
      "bureau-retry",
      "dunning",
      "webhook-dedupe-retention",
    ]);

    const report = await runSweepPlan(plan);
    expect(report.ok).toBe(true);
    expect(retrySettlementMock).toHaveBeenCalledTimes(2); // deduped markers
    expect(reconcileMock).toHaveBeenCalledOnce();
    expect(bureauRetryMock).toHaveBeenCalledOnce();
    expect(dunningMock).toHaveBeenCalledOnce();
    expect(dedupeSweepMock).toHaveBeenCalledOnce();

    const byName = Object.fromEntries(report.results.map((r) => [r.name, r.summary]));
    expect(byName["settlement-retry"]).toMatchObject({ scanned: 2, settled: 2 });
    expect(byName["mandate-charge-reconcile"]).toMatchObject({ checked: 3, settled: 2 });
    expect(byName["bureau-retry"]).toMatchObject({ attempted: 4, sent: 3 });
    expect(byName["dunning"]).toMatchObject({ reminded: 1 });
    expect(byName["webhook-dedupe-retention"]).toMatchObject({ deleted: 9 });
  });
});

describe("settlementRetryMarkerSweep", () => {
  it("tallies settled / already_settled / refused / no_pending outcomes", async () => {
    retrySettlementMock
      .mockResolvedValueOnce({ ok: true, status: "settled", reference: "a" })
      .mockResolvedValueOnce({ ok: true, status: "already_settled", reference: "b" })
      .mockResolvedValueOnce({ ok: false, status: "settlement_refused", reference: "c" })
      .mockResolvedValueOnce({ ok: false, status: "no_pending_retry", reference: "d" });
    const db = markerScanDb([
      { accountId: "acc", ref: "a" },
      { accountId: "acc", ref: "b" },
      { accountId: "acc", ref: "c" },
      { accountId: "acc", ref: "d" },
    ]);
    const out = await settlementRetryMarkerSweep(db);
    expect(out).toEqual({ scanned: 4, settled: 1, alreadySettled: 1, refused: 1, noPending: 1 });
  });
});
