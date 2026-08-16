/**
 * W17 F11 crm router tests: pipeline bucket math (pure), at-risk query,
 * win-back draft campaign creation, tenant guard enforcement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../db";
import { crmRouter, bucketPipeline } from "./crm";

const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const TENANT_USER = { user: { id: 2, role: "user", tenantId: "t1" } } as any;

beforeEach(() => vi.clearAllMocks());

describe("bucketPipeline (pure)", () => {
  it("buckets counts + value per stage and band distribution", () => {
    const r = bucketPipeline([
      { customerId: "a", band: "hot", stage: "vip", score: 90, totalSpent: 1000 },
      { customerId: "b", band: "warm", stage: "vip", score: 50, totalSpent: 500 },
      { customerId: "c", band: "cold", stage: "at_risk", score: 10, totalSpent: 250 },
      { customerId: "d", band: "cold", stage: "new_lead", score: 0, totalSpent: 0 },
    ]);
    expect(r.total).toBe(4);
    expect(r.stages.vip).toEqual({ count: 2, totalValue: 1500 });
    expect(r.stages.at_risk).toEqual({ count: 1, totalValue: 250 });
    expect(r.stages.new_lead).toEqual({ count: 1, totalValue: 0 });
    expect(r.stages.engaged).toEqual({ count: 0, totalValue: 0 });
    expect(r.bands).toEqual({ hot: 1, warm: 1, cold: 2 });
  });

  it("unknown stage/band values degrade safely", () => {
    const r = bucketPipeline([{ customerId: "x", band: "???", stage: "???", score: 1, totalSpent: 5 }]);
    expect(r.stages.new_lead.count).toBe(1);
    expect(r.bands).toEqual({ hot: 0, warm: 0, cold: 0 });
  });
});

/** Universal thenable chain returning `rows` for any select path. */
function chainTo(rows: any[]): any {
  return new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: any) => res(rows) : () => chainTo(rows)),
    apply: () => chainTo(rows),
  }) as any;
}

describe("crm.atRiskList", () => {
  const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  function mockCustomers(rows: any[]) {
    vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => chainTo(rows)) } as any);
  }

  it("returns previously-active buyers quiet for 30d+, sorted by spend desc", async () => {
    mockCustomers([
      { customerId: "hot-quiet", name: "Ada", whatsappPhone: "2341", totalOrders: 5, totalSpent: "9000.00", lastOrderAt: ago(45), score: 30, band: "cold" },
      { customerId: "active", name: "Bayo", whatsappPhone: "2342", totalOrders: 8, totalSpent: "5000.00", lastOrderAt: ago(3), score: 90, band: "hot" },
      { customerId: "one-order", name: "Chi", whatsappPhone: "2343", totalOrders: 1, totalSpent: "100.00", lastOrderAt: ago(90), score: 5, band: "cold" },
      { customerId: "never", name: "Dan", whatsappPhone: "2344", totalOrders: 0, totalSpent: "0.00", lastOrderAt: null, score: null, band: null },
      { customerId: "edge-30d", name: "Efe", whatsappPhone: "2345", totalOrders: 2, totalSpent: "200.00", lastOrderAt: ago(31), score: 20, band: "cold" },
    ]);
    const caller = crmRouter.createCaller(ADMIN);
    const out = await caller.atRiskList({ tenantId: "t1" });
    const ids = out.map((r: any) => r.customerId);
    expect(ids).toEqual(["hot-quiet", "edge-30d"]); // spend-desc order
    expect(out[0].daysSinceLastOrder).toBeGreaterThanOrEqual(30);
    expect(out[0].totalSpent).toBe(9000);
  });

  it("respects the limit", async () => {
    mockCustomers(
      Array.from({ length: 5 }, (_, i) => ({
        customerId: `c${i}`, name: null, whatsappPhone: `p${i}`, totalOrders: 3,
        totalSpent: "10.00", lastOrderAt: ago(60), score: 10, band: "cold",
      })),
    );
    const caller = crmRouter.createCaller(ADMIN);
    expect((await caller.atRiskList({ tenantId: "t1", limit: 2 })).length).toBe(2);
  });

  it("tenant guard: non-admin cannot read another tenant's at-risk list", async () => {
    mockCustomers([]);
    const caller = crmRouter.createCaller(TENANT_USER);
    await expect(caller.atRiskList({ tenantId: "OTHER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.pipelineSummary({ tenantId: "OTHER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("crm.createWinBackCampaign", () => {
  it("creates a draft custom-segment campaign targeting the at-risk window", async () => {
    const inserted: any[] = [];
    vi.mocked(getDb).mockResolvedValue({
      insert: vi.fn(() => ({ values: vi.fn((v: any) => { inserted.push(v); return Promise.resolve([]); }) })),
    } as any);
    const caller = crmRouter.createCaller(TENANT_USER); // own tenant
    const r = await caller.createWinBackCampaign({ tenantId: "t1", name: "Come back!" });
    expect(r.id).toBeTruthy();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].tenantId).toBe("t1");
    expect(inserted[0].status).toBe("draft");
    expect(inserted[0].segment).toBe("custom");
    expect(inserted[0].segmentFilter).toEqual({ minOrders: 1, noOrderSinceDays: 30 });
  });

  it("tenant guard: cannot create a campaign for another tenant", async () => {
    vi.mocked(getDb).mockResolvedValue({ insert: vi.fn() } as any);
    const caller = crmRouter.createCaller(TENANT_USER);
    await expect(caller.createWinBackCampaign({ tenantId: "OTHER", name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("crm.getScoreBreakdown", () => {
  it("returns factors for a scored customer, 404 otherwise", async () => {
    const row = {
      customerId: "c1", score: 75, band: "hot", stage: "repeat",
      factors: [{ factor: "recency:ordered_within_7d", delta: 25 }], computedAt: new Date(),
    };
    vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => chainTo([row])) } as any);
    const caller = crmRouter.createCaller(ADMIN);
    const out = await caller.getScoreBreakdown({ tenantId: "t1", customerId: "c1" });
    expect(out.score).toBe(75);
    expect(out.factors).toHaveLength(1);

    vi.mocked(getDb).mockResolvedValue({ select: vi.fn(() => chainTo([])) } as any);
    await expect(caller.getScoreBreakdown({ tenantId: "t1", customerId: "none" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
