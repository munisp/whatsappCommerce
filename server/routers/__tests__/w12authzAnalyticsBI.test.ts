/**
 * W12 authz — analyticsBI: every procedure that takes client input.tenantId
 * (or resolves a row's tenant) must enforce assertTenantAccess.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { analyticsBIRouter } from "../analyticsBI";

const T1 = "tenant-1";
const T2 = "tenant-2";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values", "onConflictDoUpdate"]) c[m] = () => c;
  return c;
}

/** selectResponses: one entry per awaited select chain, in call order. */
function makeDb(selectResponses: any[] = []) {
  let i = 0;
  return {
    select: vi.fn(() => makeChain(selectResponses[i++] ?? [])),
    insert: vi.fn(() => makeChain([])),
    update: vi.fn(() => makeChain([])),
  } as any;
}

const OWN = { user: { id: 2, role: "user", tenantId: T1 } } as any;
const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;

beforeEach(() => vi.clearAllMocks());

describe("analyticsBI tenant isolation", () => {
  it("listCohorts: cross-tenant read rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(caller.listCohorts({ tenantId: T2, limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listCohorts: own tenant works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[]]));
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(caller.listCohorts({ tenantId: T1, limit: 5 })).resolves.toEqual([]);
  });

  it("upsertCohort: cross-tenant write rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(
      caller.upsertCohort({ tenantId: T2, cohortMonth: "2025-01", totalCustomers: 10, retentionByMonth: {} }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("upsertCohort: own tenant works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(
      caller.upsertCohort({ tenantId: T1, cohortMonth: "2025-01", totalCustomers: 10, retentionByMonth: {} }),
    ).resolves.toEqual({ ok: true });
  });

  it("listChurnRisks: cross-tenant read rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(caller.listChurnRisks({ tenantId: T2, limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("upsertChurnPrediction: cross-tenant write rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(
      caller.upsertChurnPrediction({ tenantId: T2, customerPhone: "123", churnScore: "0.9", riskLevel: "high" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("markInterventionSent: cannot touch another tenant's row (resolved by id)", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[{ id: "c1", tenantId: T2 }]]));
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(caller.markInterventionSent({ id: "c1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("markInterventionSent: own tenant row works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[{ id: "c1", tenantId: T1 }]]));
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(caller.markInterventionSent({ id: "c1" })).resolves.toEqual({ ok: true });
  });

  it("biSummary: cross-tenant read rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = analyticsBIRouter.createCaller(OWN);
    await expect(caller.biSummary({ tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("biSummary: admin bypass works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[], []]));
    const caller = analyticsBIRouter.createCaller(ADMIN);
    const r = await caller.biSummary({ tenantId: T2 });
    expect(r.totalChurnTracked).toBe(0);
  });
});
