/**
 * W12 authz — inventory router: formerly public stock endpoints are now
 * protected + tenant-scoped; mutations assert tenant access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { inventoryRouter } from "../inventory";

const T1 = "tenant-1";
const T2 = "tenant-2";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values", "onConflictDoUpdate"]) c[m] = () => c;
  return c;
}

function makeDb(executeResponses: any[] = [], selectResponses: any[] = []) {
  let ei = 0, si = 0;
  return {
    execute: vi.fn(() => Promise.resolve(executeResponses[ei++] ?? [])),
    select: vi.fn(() => makeChain(selectResponses[si++] ?? [])),
    insert: vi.fn(() => makeChain([])),
    update: vi.fn(() => makeChain([])),
  } as any;
}

const OWN = { user: { id: 2, role: "user", tenantId: T1 } } as any;
const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const ANON = { user: null } as any;

beforeEach(() => vi.clearAllMocks());

describe("inventory.getStockLevels", () => {
  it("rejects unauthenticated callers (was publicProcedure)", async () => {
    const caller = inventoryRouter.createCaller(ANON);
    await expect(caller.getStockLevels({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects cross-tenant reads", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = inventoryRouter.createCaller(OWN);
    await expect(caller.getStockLevels({ tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows own-tenant reads", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[{ productId: "p1" }]]));
    const caller = inventoryRouter.createCaller(OWN);
    const r = await caller.getStockLevels({ tenantId: T1 });
    expect(r).toEqual([{ productId: "p1" }]);
  });
});

describe("inventory.getStockAlerts", () => {
  it("rejects unauthenticated callers", async () => {
    const caller = inventoryRouter.createCaller(ANON);
    await expect(caller.getStockAlerts({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects cross-tenant reads", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = inventoryRouter.createCaller(OWN);
    await expect(caller.getStockAlerts({ tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows own-tenant reads", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[{ outOfStock: 1, lowStock: 2, inStock: 3, lastSyncedAt: null }]]));
    const caller = inventoryRouter.createCaller(OWN);
    const r = await caller.getStockAlerts({ tenantId: T1 });
    expect(r.outOfStock).toBe(1);
  });
});

describe("inventory mutations", () => {
  it("syncFromOdoo: cross-tenant rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = inventoryRouter.createCaller(OWN);
    await expect(caller.syncFromOdoo({ tenantId: T2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("syncFromOdoo: admin bypass works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([], [[]]));
    const caller = inventoryRouter.createCaller(ADMIN);
    const r = await caller.syncFromOdoo({ tenantId: T2 });
    expect(r.success).toBe(true);
  });

  it("reserveStock: cross-tenant rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = inventoryRouter.createCaller(OWN);
    await expect(caller.reserveStock({ tenantId: T2, productId: "p1", qty: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reserveStock: own tenant works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[{ id: "s1", availableQty: 4, reservedQty: 1 }]]));
    const caller = inventoryRouter.createCaller(OWN);
    const r = await caller.reserveStock({ tenantId: T1, productId: "p1", qty: 1 });
    expect(r.reserved).toBe(true);
  });

  it("releaseReservation: cross-tenant rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = inventoryRouter.createCaller(OWN);
    await expect(caller.releaseReservation({ tenantId: T2, productId: "p1", qty: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("getSyncHistory: unauthenticated rejected (was publicProcedure)", async () => {
    const caller = inventoryRouter.createCaller(ANON);
    await expect(caller.getSyncHistory({ tenantId: T1, limit: 5 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("getSyncHistory: cross-tenant rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = inventoryRouter.createCaller(OWN);
    await expect(caller.getSyncHistory({ tenantId: T2, limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
