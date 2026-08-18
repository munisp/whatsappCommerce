/**
 * W23 — journeyOrchestrator service tests (mutation-proof).
 *
 * Covers: registry validation, local-fallback happy path (checkpoints +
 * idempotency keys), resume-after-crash (completed activities are NOT
 * re-executed, run stays 'running' on failure), cron tick resumption,
 * unknown-journey rejection. Runs on the generic in-memory fake db
 * (testUtils/soc2FakeDb) extended with onConflictDoNothing — deterministic,
 * no Temporal, no PG.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../db";
import { temporalWorkflowRuns } from "../../drizzle/schema";
import { makeSoc2FakeDb } from "./testUtils/soc2FakeDb";
import {
  __unregisterJourneyOrchestration,
  executeOrchestrationLocally,
  getOrchestrationHistory,
  getOrchestrationStatus,
  listRegisteredOrchestrations,
  registerJourneyOrchestration,
  runOrchestrationTick,
  startJourneyOrchestration,
} from "./journeyOrchestrator";

/** soc2FakeDb + the onConflictDoNothing chain startWorkflow relies on. */
function makeDb() {
  const store = new Map<any, any[]>([[temporalWorkflowRuns, []]]);
  const inner = makeSoc2FakeDb(store);
  const db: any = {
    select: inner.select,
    update: inner.update,
    delete: inner.delete,
    insert(table: any) {
      return {
        values(v: any) {
          const out = inner.insert(table).values(v);
          return {
            returning: out.returning,
            then: out.then,
            onConflictDoNothing() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
  return { db, rows: store.get(temporalWorkflowRuns)! };
}

let rows: any[];
beforeEach(() => {
  vi.clearAllMocks();
  const made = makeDb();
  rows = made.rows;
  vi.mocked(getDb).mockResolvedValue(made.db);
});

describe("registerJourneyOrchestration", () => {
  it("rejects empty/duplicate activity lists", () => {
    expect(() => registerJourneyOrchestration("", [{ name: "a", run: async () => 1 }])).toThrow();
    expect(() => registerJourneyOrchestration("bad-dupes", [
      { name: "a", run: async () => 1 },
      { name: "a", run: async () => 2 },
    ])).toThrow(/duplicate/);
    expect(() => registerJourneyOrchestration("bad-empty", [])).toThrow();
    __unregisterJourneyOrchestration("bad-dupes");
    __unregisterJourneyOrchestration("bad-empty");
  });
});

describe("startJourneyOrchestration (local fallback)", () => {
  it("rejects an unknown journey id", async () => {
    await expect(startJourneyOrchestration("nope-404", {})).rejects.toThrow(/unknown orchestration journey/);
  });

  it("executes every activity with checkpoints + per-activity idempotency keys", async () => {
    const order: string[] = [];
    registerJourneyOrchestration("t-happy", [
      { name: "one", run: async () => { order.push("one"); return { n: 1 }; } },
      { name: "two", run: async (ctx) => { order.push("two"); return { prev: ctx.outputs.one }; } },
      { name: "three", run: async () => { order.push("three"); return { n: 3 }; } },
    ]);
    try {
      const res = await startJourneyOrchestration("t-happy", { k: "v" }, { tenantId: "t1" });
      expect(res.mode).toBe("local-fallback");
      expect(res.status).toBe("completed");
      expect(res.executed).toEqual(["one", "two", "three"]);
      expect(order).toEqual(["one", "two", "three"]);

      expect(rows).toHaveLength(1);
      const run = rows[0];
      expect(run.workflowType).toBe("JourneyOrchestrationWorkflow");
      expect(run.tenantId).toBe("t1");
      expect(run.status).toBe("completed");
      const result = run.result as any;
      expect(result.mode).toBe("local-fallback");
      expect(result.journeyId).toBe("t-happy");
      expect(result.checkpoints.map((c: any) => c.name)).toEqual(["one", "two", "three"]);
      // Deterministic idempotency keys: `${runId}:${activity}`.
      expect(result.checkpoints[0].key).toBe(`${run.runId}:one`);
      expect(result.checkpoints[2].key).toBe(`${run.runId}:three`);
      // Outputs chain through ctx.outputs.
      expect(result.checkpoints[1].output.prev).toEqual({ n: 1 });

      const status = await getOrchestrationStatus(run.runId);
      expect(status.status).toBe("completed");
      expect(status.checkpointCount).toBe(3);
      const history = await getOrchestrationHistory(run.runId);
      expect(history.checkpoints).toHaveLength(3);
      expect(history.closedAt).toBeTruthy();
    } finally {
      __unregisterJourneyOrchestration("t-happy");
    }
  });

  it("defers execution when deferExecution=true", async () => {
    let ran = 0;
    registerJourneyOrchestration("t-defer", [{ name: "a", run: async () => { ran++; } }]);
    try {
      const res = await startJourneyOrchestration("t-defer", {}, { deferExecution: true });
      expect(res.status).toBe("running");
      expect(ran).toBe(0);
      expect(rows[0].status).toBe("running");
    } finally {
      __unregisterJourneyOrchestration("t-defer");
    }
  });
});

describe("resume after crash", () => {
  it("a mid-run failure stays 'running'; resume skips checkpointed activities", async () => {
    const counts = { one: 0, two: 0, three: 0 };
    let crashArmed = true;
    registerJourneyOrchestration("t-crash", [
      { name: "one", run: async () => { counts.one++; return 1; } },
      { name: "two", run: async () => { counts.two++; if (crashArmed) throw new Error("boom"); return 2; } },
      { name: "three", run: async () => { counts.three++; return 3; } },
    ]);
    try {
      const first = await startJourneyOrchestration("t-crash", {}, { tenantId: "t9" });
      expect(first.status).toBe("running");
      expect(first.error).toMatch(/boom/);
      expect(counts).toEqual({ one: 1, two: 1, three: 0 });
      const run = rows[0];
      expect(run.status).toBe("running");
      expect((run.result as any).checkpoints.map((c: any) => c.name)).toEqual(["one"]);
      expect((run.result as any).lastError).toMatch(/boom/);

      // Crash fixed — resume from the last checkpoint.
      crashArmed = false;
      const second = await executeOrchestrationLocally(await (getDb() as any), run.runId);
      expect(second.status).toBe("completed");
      expect(second.executed).toEqual(["two", "three"]);
      // Activity 'one' was checkpointed — NOT re-executed.
      expect(counts).toEqual({ one: 1, two: 2, three: 1 });
      expect(rows[0].status).toBe("completed");
      expect((rows[0].result as any).checkpoints.map((c: any) => c.name)).toEqual(["one", "two", "three"]);

      // Idempotent re-resume of a completed run: nothing re-executes.
      const third = await executeOrchestrationLocally(await (getDb() as any), run.runId);
      expect(third.executed).toEqual([]);
      expect(counts).toEqual({ one: 1, two: 2, three: 1 });
    } finally {
      __unregisterJourneyOrchestration("t-crash");
    }
  });
});

describe("runOrchestrationTick", () => {
  it("resumes only local-fallback 'running' orchestrations", async () => {
    let ran = 0;
    registerJourneyOrchestration("t-tick", [{ name: "x", run: async () => { ran++; } }]);
    try {
      const res = await startJourneyOrchestration("t-tick", {}, { deferExecution: true });
      expect(ran).toBe(0);
      // A Temporal-owned run (non local- runId) must be skipped by the tick.
      rows.push({
        id: "r-temporal", workflowId: "w-t", runId: "real-temporal-run",
        workflowType: "JourneyOrchestrationWorkflow", taskQueue: "whatsapp-commerce",
        tenantId: "t1", status: "running", input: { journeyId: "t-tick", params: {} },
        startedAt: new Date(),
      });
      const db = await (getDb() as any);
      const summary = await runOrchestrationTick(db);
      expect(summary).toEqual({ resumed: 1, completed: 1, stillRunning: 0, errors: 0 });
      expect(ran).toBe(1);
      expect(rows.find((r) => r.runId === res.runId).status).toBe("completed");
      expect(rows.find((r) => r.runId === "real-temporal-run").status).toBe("running");
    } finally {
      __unregisterJourneyOrchestration("t-tick");
    }
  });
});

describe("built-in orchestrations", () => {
  it("j121-fullstack registers with the five canonical activities", async () => {
    const { ensureBuiltinOrchestrations, FULLSTACK_JOURNEY_ID } = await import("./journeyOrchestrator.journeys");
    ensureBuiltinOrchestrations();
    ensureBuiltinOrchestrations(); // idempotent
    expect(listRegisteredOrchestrations()).toContain(FULLSTACK_JOURNEY_ID);
    const { getJourneyActivities } = await import("./journeyOrchestrator");
    expect(getJourneyActivities(FULLSTACK_JOURNEY_ID)!.map((a) => a.name)).toEqual([
      "discoverCatalog",
      "createOrder",
      "creditFacilityPd",
      "visualInventoryDecrement",
      "complianceAudit",
    ]);
  });
});
