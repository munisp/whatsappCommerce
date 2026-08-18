/**
 * W22 copilot router tests — tenant guards (anon/cross-tenant), happy paths
 * with the LLM disabled (deterministic fallback), and copilot_queries
 * history shape (hashes only, tenant-scoped).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../../_core/llm", () => ({ invokeLLM: vi.fn() }));

import { getDb } from "../../db";
import { copilotRouter } from "../copilot";
import { makeSoc2FakeDb } from "../../services/testUtils/soc2FakeDb";
import { anomalyAlerts, copilotQueries, creditAccounts, incidents, orders } from "../../../drizzle/schema";

const T1 = "tenant-1";
const T2 = "tenant-2";
const INC_ID = "11111111-1111-4111-8111-111111111111";

let store: Map<any, any[]>;
function seed() {
  store = new Map<any, any[]>([
    [incidents, [{
      id: INC_ID, tenantId: T1, severity: "low", status: "open",
      title: "Payment webhook outage", description: "callbacks failing",
      openedAt: new Date("2026-02-01T03:00:00Z"), resolvedAt: null,
    }]],
    [anomalyAlerts, []],
    [orders, [{ id: "o1", tenantId: T1, totalAmount: "100.00", createdAt: new Date(), items: [{ name: "Rice", quantity: 2 }] }]],
    [creditAccounts, []],
    [copilotQueries, []],
  ]);
  (getDb as any).mockResolvedValue(makeSoc2FakeDb(store));
}

function callerFor(tenantId: string | null) {
  return copilotRouter.createCaller({
    user: { id: 5, openId: "u5", role: "user", tenantId, name: "U5", email: null, loginMethod: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { headers: {} },
    res: {},
  } as any);
}
const anon = () => copilotRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COPILOT_LLM_ENABLED;
  seed();
});

describe("tenant guards", () => {
  it("rejects anonymous callers", async () => {
    await expect(anon().triageIncident({ tenantId: T1, incidentId: INC_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon().ask({ tenantId: T1, question: "sales?" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon().history({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects cross-tenant callers on every procedure", async () => {
    const c = callerFor(T2);
    await expect(c.triageIncident({ tenantId: T1, incidentId: INC_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.ask({ tenantId: T1, question: "sales?" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.history({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("triage never leaks another tenant's incident (row scoped by tenantId)", async () => {
    const c = callerFor(T2);
    const res = await c.triageIncident({ tenantId: T2, incidentId: INC_ID }); // incident belongs to T1
    expect(res.fallbackUsed).toBe(true);
    expect(res.likelyCause).toContain("not found");
  });
});

describe("happy paths (LLM disabled → deterministic fallback)", () => {
  it("triageIncident returns a structured suggestion and logs it", async () => {
    const c = callerFor(T1);
    const res = await c.triageIncident({ tenantId: T1, incidentId: INC_ID });
    expect(res.fallbackUsed).toBe(true);
    expect(res.severitySuggestion).toBe("high"); // "payment webhook outage"
    expect(res.runbookSteps.length).toBeGreaterThan(0);
    expect(res.postmortemDraft).toContain("Payment webhook outage");
    expect(store.get(copilotQueries)!).toHaveLength(1);
    expect(store.get(copilotQueries)![0].kind).toBe("triage");
  });

  it("ask returns an aggregate-grounded answer", async () => {
    const c = callerFor(T1);
    const res = await c.ask({ tenantId: T1, question: "what did I sell today?" });
    expect(res.fallbackUsed).toBe(true);
    expect(res.snapshot.ordersToday).toBe(1);
    expect(res.snapshot.salesCentsToday).toBe(10000);
    expect(res.answer).toContain("100.00");
  });

  it("history returns tenant-scoped hash-only rows", async () => {
    const c = callerFor(T1);
    await c.triageIncident({ tenantId: T1, incidentId: INC_ID });
    await c.ask({ tenantId: T1, question: "credit balance?" });
    const all = await c.history({ tenantId: T1 });
    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(row)).not.toContain("prompt");
      expect(row.tenantId).toBe(T1);
    }
    const triageOnly = await c.history({ tenantId: T1, kind: "triage" });
    expect(triageOnly).toHaveLength(1);
    expect(triageOnly[0].kind).toBe("triage");
  });
});
