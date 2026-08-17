/**
 * W13 router — mandate gate on approveAccount (₦50k floor) and the
 * requestMandate / confirmMandate / initiateRepayment procedures.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../../services/kycGate", () => ({
  requireApprovedKyb: vi.fn(async () => {}),
}));

import { getDb } from "../../db";
import { tradeCreditRouter } from "../tradeCredit";
import { makeFakeDb, seedAccount, seedMandate } from "../../services/tradeCredit/fakeDb";
import { FLOOR_LIMIT_CENTS } from "../../services/tradeCredit/scoring";

const SUPPLIER = { user: { id: "u-s", role: "admin", tenantId: "supplier-1" } } as any;
const BUYER = { user: { id: "u-b", role: "admin", tenantId: "buyer-1" } } as any;

let storeRef: ReturnType<typeof makeFakeDb>["store"];

beforeEach(() => {
  vi.clearAllMocks();
});

function useDb(seed: Parameters<typeof makeFakeDb>[0]) {
  const { db, store } = makeFakeDb(seed);
  storeRef = store;
  (getDb as any).mockResolvedValue(db);
  return { db, store };
}

function pendingAccount(over: Record<string, unknown> = {}) {
  return seedAccount({ id: "acct-1", status: "pending", limitCents: 0, ...over });
}

describe("approveAccount mandate gate", () => {
  it("refuses activation above the ₦50k floor without an active mandate", async () => {
    useDb({ accounts: [pendingAccount()] });
    const caller = tradeCreditRouter.createCaller(SUPPLIER);
    await expect(
      caller.approveAccount({ supplierTenantId: "supplier-1", accountId: "acct-1", limitCents: FLOOR_LIMIT_CENTS + 1 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(storeRef.accounts[0].status).toBe("pending");
  });

  it("activates floor-level facilities without a mandate (micro-credit frictionless)", async () => {
    useDb({ accounts: [pendingAccount()] });
    const caller = tradeCreditRouter.createCaller(SUPPLIER);
    const row = await caller.approveAccount({
      supplierTenantId: "supplier-1", accountId: "acct-1", limitCents: FLOOR_LIMIT_CENTS,
    });
    expect(row.status).toBe("active");
    expect(row.limitCents).toBe(FLOOR_LIMIT_CENTS);
  });

  it("activates above-floor facilities when the buyer holds an active mandate (auto-links)", async () => {
    const mandate = seedMandate({ id: "m-1", tenantId: "buyer-1", status: "active" });
    useDb({ accounts: [pendingAccount()], mandates: [mandate] });
    const caller = tradeCreditRouter.createCaller(SUPPLIER);
    const row = await caller.approveAccount({
      supplierTenantId: "supplier-1", accountId: "acct-1", limitCents: FLOOR_LIMIT_CENTS * 10,
    });
    expect(row.status).toBe("active");
    expect(storeRef.accounts[0].mandateId).toBe("m-1");
  });

  it("a merely-pending mandate does not satisfy the gate", async () => {
    const mandate = seedMandate({ id: "m-1", tenantId: "buyer-1", status: "pending" });
    useDb({ accounts: [pendingAccount({ mandateId: "m-1" })], mandates: [mandate] });
    const caller = tradeCreditRouter.createCaller(SUPPLIER);
    await expect(
      caller.approveAccount({ supplierTenantId: "supplier-1", accountId: "acct-1", limitCents: FLOOR_LIMIT_CENTS + 1 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("requestMandate / confirmMandate", () => {
  it("requestMandate creates + links a mandate for the buyer (dev fake active)", async () => {
    useDb({ accounts: [seedAccount({ id: "acct-1" })] });
    const caller = tradeCreditRouter.createCaller(BUYER);
    const res = await caller.requestMandate({ buyerTenantId: "buyer-1", accountId: "acct-1" });
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("fake");
    expect(storeRef.mandates).toHaveLength(1);
    expect(storeRef.accounts[0].mandateId).toBe(storeRef.mandates[0].id);
  });

  it("confirmMandate flips a pending mandate to active, exactly once", async () => {
    const mandate = seedMandate({ id: "m-1", tenantId: "buyer-1", status: "pending" });
    useDb({ mandates: [mandate] });
    const caller = tradeCreditRouter.createCaller(BUYER);
    const row = await caller.confirmMandate({ buyerTenantId: "buyer-1", mandateId: "m-1" });
    expect(row.status).toBe("active");
    await expect(caller.confirmMandate({ buyerTenantId: "buyer-1", mandateId: "m-1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("mandate procedures are tenant-scoped", async () => {
    const mandate = seedMandate({ id: "m-1", tenantId: "buyer-1", status: "pending" });
    useDb({ mandates: [mandate] });
    const other = tradeCreditRouter.createCaller({ user: { id: "x", role: "admin", tenantId: "buyer-2" } } as any);
    await expect(other.confirmMandate({ buyerTenantId: "buyer-2", mandateId: "m-1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revokeMandate revokes and detaches the facility link", async () => {
    const mandate = seedMandate({ id: "m-1", tenantId: "buyer-1", status: "active" });
    const account = seedAccount({ id: "acct-1", mandateId: "m-1" });
    useDb({ accounts: [account], mandates: [mandate] });
    const caller = tradeCreditRouter.createCaller(BUYER);
    const res = await caller.revokeMandate({ buyerTenantId: "buyer-1", mandateId: "m-1" });
    expect(res.ok).toBe(true);
    expect(storeRef.mandates[0].status).toBe("revoked");
    expect(storeRef.accounts[0].mandateId).toBeNull();
  });
});

describe("initiateRepayment", () => {
  it("charges the active fake mandate at source (dev mode) and settles", async () => {
    const mandate = seedMandate({ id: "m-1", tenantId: "buyer-1", status: "active" });
    const account = seedAccount({ id: "acct-1", mandateId: "m-1", outstandingCents: 10_000 });
    useDb({ accounts: [account], mandates: [mandate] });
    const caller = tradeCreditRouter.createCaller(BUYER);
    const res = await caller.initiateRepayment({ buyerTenantId: "buyer-1", accountId: "acct-1", amountCents: 4_000 });
    expect(res).toMatchObject({ ok: true, mode: "mandate", outstandingAfter: 6_000 });
    expect(storeRef.accounts[0].outstandingCents).toBe(6_000);
  });

  it("refuses when the account is unknown to the buyer", async () => {
    useDb({ accounts: [seedAccount({ id: "acct-1", outstandingCents: 5_000 })] });
    const caller = tradeCreditRouter.createCaller(BUYER);
    await expect(caller.initiateRepayment({ buyerTenantId: "buyer-1", accountId: "nope", amountCents: 100 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
