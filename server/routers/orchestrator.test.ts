/**
 * W23 — orchestrator router tests: tenant guard + happy path + history.
 *
 * db is mocked (vi.mock ../db) over the generic in-memory fake; Temporal is
 * unset so every start exercises the local-fallback path deterministically.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../db";
import { temporalWorkflowRuns } from "../../drizzle/schema";
import { makeSoc2FakeDb } from "../services/testUtils/soc2FakeDb";
import { orchestratorRouter } from "./orchestrator";
import {
  __unregisterJourneyOrchestration,
  registerJourneyOrchestration,
} from "../services/journeyOrchestrator";

const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const T1 = { user: { id: 2, role: "user", tenantId: "t1" } } as any;
const T2 = { user: { id: 3, role: "user", tenantId: "t2" } } as any;

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
            onConflictDoNothing() { return Promise.resolve([]); },
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
  registerJourneyOrchestration("t-router", [
    { name: "stepA", run: async () => ({ ok: true }) },
    { name: "stepB", run: async () => ({ ok: true }) },
  ]);
  return () => __unregisterJourneyOrchestration("t-router");
});

describe("orchestrator.start", () => {
  it("tenant user starts an orchestration for their own tenant (happy path)", async () => {
    const caller = orchestratorRouter.createCaller(T1);
    const res = await caller.start({ journeyId: "t-router", tenantId: "t1", params: { p: 1 }, deferExecution: false });
    expect(res.status).toBe("completed");
    expect(res.executed).toEqual(["stepA", "stepB"]);
    expect(rows[0].tenantId).toBe("t1");
    expect(rows[0].status).toBe("completed");
  });

  it("FORBIDDEN when starting for another tenant", async () => {
    const caller = orchestratorRouter.createCaller(T1);
    await expect(
      caller.start({ journeyId: "t-router", tenantId: "t2", params: {}, deferExecution: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows).toHaveLength(0);
  });

  it("UNAUTHORIZED without a user", async () => {
    const caller = orchestratorRouter.createCaller({} as any);
    await expect(
      caller.start({ journeyId: "t-router", tenantId: "t1", params: {}, deferExecution: false }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("BAD_REQUEST for an unknown journeyId", async () => {
    const caller = orchestratorRouter.createCaller(ADMIN);
    await expect(
      caller.start({ journeyId: "does-not-exist", tenantId: "t1", params: {}, deferExecution: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("orchestrator.status / orchestrator.history", () => {
  it("same-tenant read works; cross-tenant read is FORBIDDEN", async () => {
    const start = await orchestratorRouter.createCaller(T1)
      .start({ journeyId: "t-router", tenantId: "t1", params: {}, deferExecution: false });
    const status = await orchestratorRouter.createCaller(T1).status({ runId: start.runId });
    expect(status.status).toBe("completed");
    expect(status.checkpointCount).toBe(2);
    const history = await orchestratorRouter.createCaller(T1).history({ runId: start.runId });
    expect(history.checkpoints.map((c) => c.name)).toEqual(["stepA", "stepB"]);

    await expect(
      orchestratorRouter.createCaller(T2).status({ runId: start.runId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      orchestratorRouter.createCaller(T2).history({ runId: start.runId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Admin can read any tenant's run.
    const adminStatus = await orchestratorRouter.createCaller(ADMIN).status({ runId: start.runId });
    expect(adminStatus.status).toBe("completed");
  });

  it("NOT_FOUND for an unknown runId", async () => {
    await expect(
      orchestratorRouter.createCaller(T1).status({ runId: "local-nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
