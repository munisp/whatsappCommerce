/**
 * tradeCredit.approveAccount KYB gate tests (w12).
 *
 * Both sides of a credit facility (supplier + buyer) must hold an approved
 * KYB application before approval. requestAccount stays open. The tradeCredit
 * service layer is mocked (its money logic is covered by services/tradeCredit
 * tests); the kyc_applications lookup runs against an in-memory fake db.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

const tc = vi.hoisted(() => ({
  approveCreditAccountTx: vi.fn(async (_db: any, input: any) => ({
    id: input.accountId, status: "active",
  })),
  getCreditAccountByIdTx: vi.fn(async () => null as any),
  requestCreditAccountTx: vi.fn(async (_db: any, input: any) => ({
    id: "acct-new", ...input, status: "pending",
  })),
}));

vi.mock("./services/tradeCredit", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    approveCreditAccountTx: tc.approveCreditAccountTx,
    getCreditAccountByIdTx: tc.getCreditAccountByIdTx,
    requestCreditAccountTx: tc.requestCreditAccountTx,
  };
});

// In-memory kyc_applications store behind the drizzle chain used by kycGate.
const kycRows: any[] = [];
function fakeDb() {
  const chain: any = {
    limit: () => chain,
    then: (res: (v: any) => any, rej?: (e: any) => any) => Promise.resolve(kycRows).then(res, rej),
    catch: (rej: (e: any) => any) => Promise.resolve(kycRows).catch(rej),
  };
  return { select: () => ({ from: () => ({ where: () => chain }) }) };
}
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => fakeDb()) };
});

// assertMoneyAccess (used by approveAccount as of the 2026-09-20 role-scoping
// fix) looks up a tenant_memberships row via getMembership. fakeDb() above is
// a single-table kyc_applications stand-in and would otherwise misanswer
// that query with a KYC row. Mock getMembership to report "no membership
// row" so assertMoneyAccess falls through to the legacy users.tenantId
// shortcut — which is exactly what makeCtx()'s single-user fixture models.
vi.mock("./services/membership", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getMembership: vi.fn(async () => null) };
});

import { appRouter } from "./routers";

function makeCtx(tenantId: string): TrpcContext {
  return {
    user: {
      id: 1, openId: "u1", email: "s@e.c", name: "S", loginMethod: "keycloak",
      role: "user", tenantId, phone: null, phoneVerified: false,
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as any,
    req: {} as any,
    res: {} as any,
  } as TrpcContext;
}

const ACCOUNT = {
  id: "acct-1",
  supplierTenantId: "sup-1",
  buyerTenantId: "buy-1",
  status: "pending",
};

function approveKyb(tenantId: string) {
  kycRows.push({ tenantId, type: "kyb", status: "approved" });
}

beforeEach(() => {
  kycRows.length = 0;
  vi.clearAllMocks();
  tc.getCreditAccountByIdTx.mockResolvedValue({ ...ACCOUNT });
});

describe("tradeCredit.approveAccount KYB gate", () => {
  it("blocks when the SUPPLIER has no approved KYB", async () => {
    approveKyb("buy-1");
    const caller = appRouter.createCaller(makeCtx("sup-1"));
    await expect(
      caller.tradeCredit.approveAccount({ supplierTenantId: "sup-1", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tc.approveCreditAccountTx).not.toHaveBeenCalled();
  });

  it("blocks when the BUYER has no approved KYB", async () => {
    approveKyb("sup-1");
    const caller = appRouter.createCaller(makeCtx("sup-1"));
    await expect(
      caller.tradeCredit.approveAccount({ supplierTenantId: "sup-1", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tc.approveCreditAccountTx).not.toHaveBeenCalled();
  });

  it("blocks when KYB exists but is not approved", async () => {
    kycRows.push(
      { tenantId: "sup-1", type: "kyb", status: "under_review" },
      { tenantId: "buy-1", type: "kyc", status: "approved" },
    );
    const caller = appRouter.createCaller(makeCtx("sup-1"));
    await expect(
      caller.tradeCredit.approveAccount({ supplierTenantId: "sup-1", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tc.approveCreditAccountTx).not.toHaveBeenCalled();
  });

  it("approves when BOTH sides are KYB-verified", async () => {
    approveKyb("sup-1");
    approveKyb("buy-1");
    const caller = appRouter.createCaller(makeCtx("sup-1"));
    const res = await caller.tradeCredit.approveAccount({
      supplierTenantId: "sup-1", accountId: "acct-1", limitCents: 100_000,
    });
    expect(res).toMatchObject({ id: "acct-1", status: "active" });
    expect(tc.approveCreditAccountTx).toHaveBeenCalledTimes(1);
  });

  it("NOT_FOUND for an account owned by another supplier (no leak)", async () => {
    approveKyb("sup-1");
    approveKyb("buy-1");
    tc.getCreditAccountByIdTx.mockResolvedValue({ ...ACCOUNT, supplierTenantId: "sup-other" });
    const caller = appRouter.createCaller(makeCtx("sup-1"));
    await expect(
      caller.tradeCredit.approveAccount({ supplierTenantId: "sup-1", accountId: "acct-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tc.approveCreditAccountTx).not.toHaveBeenCalled();
  });
});

describe("tradeCredit.requestAccount stays open (request only)", () => {
  it("a buyer can REQUEST credit without any KYB approval", async () => {
    const caller = appRouter.createCaller(makeCtx("buy-1"));
    const res = await caller.tradeCredit.requestAccount({
      buyerTenantId: "buy-1", supplierTenantId: "sup-1",
    });
    expect(res).toMatchObject({ status: "pending" });
    expect(tc.requestCreditAccountTx).toHaveBeenCalledTimes(1);
  });
});
