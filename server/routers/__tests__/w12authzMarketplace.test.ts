/**
 * W12 authz — marketplace.updateSellerStatus / updateSellerCommission are
 * platform-admin only (seller approval + commission rate = money movement).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { marketplaceRouter } from "../marketplace";

function makeDb() {
  const p = Promise.resolve([]);
  const chain: any = { then: (r: any, j: any) => p.then(r, j), catch: (j: any) => p.catch(j) };
  for (const m of ["set", "where", "values", "from"]) chain[m] = () => chain;
  return { update: vi.fn(() => chain), select: vi.fn(() => chain), insert: vi.fn(() => chain) } as any;
}

const ADMIN = { user: { id: 1, role: "admin", tenantId: null } } as any;
const TENANT_USER = { user: { id: 2, role: "user", tenantId: "tenant-1" } } as any;

beforeEach(() => vi.clearAllMocks());

describe("marketplace admin gates", () => {
  it("updateSellerStatus: non-admin rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = marketplaceRouter.createCaller(TENANT_USER);
    await expect(caller.updateSellerStatus({ id: "s1", status: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("updateSellerStatus: unauthenticated rejected", async () => {
    const caller = marketplaceRouter.createCaller({ user: null } as any);
    await expect(caller.updateSellerStatus({ id: "s1", status: "active" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("updateSellerStatus: platform admin works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = marketplaceRouter.createCaller(ADMIN);
    await expect(caller.updateSellerStatus({ id: "s1", status: "active" })).resolves.toEqual({ ok: true });
  });

  it("updateSellerCommission: non-admin rejected", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = marketplaceRouter.createCaller(TENANT_USER);
    await expect(caller.updateSellerCommission({ id: "s1", commissionRate: "0.5" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("updateSellerCommission: platform admin works", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = marketplaceRouter.createCaller(ADMIN);
    await expect(caller.updateSellerCommission({ id: "s1", commissionRate: "12.00" })).resolves.toEqual({ ok: true });
  });
});
