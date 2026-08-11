/**
 * tradeCredit router — tenant isolation and RBAC tests.
 *
 * getDb is mocked to a shared in-memory store (the same honest
 * conditional-update fake as the service tests) so procedure-level behavior
 * — assertTenantAccess gates, cross-tenant NOT_FOUNDs, limit-increase notes —
 * is exercised end-to-end through the real tRPC router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { makeFakeDb, seedAccount, seedDraw, seedKycApplication } from "./services/tradeCredit/fakeDb";

const fake = makeFakeDb({
  accounts: [
    seedAccount({ id: "acc-A", supplierTenantId: "supplier-A", buyerTenantId: "buyer-A", limitCents: 100_000, outstandingCents: 20_000 }),
    seedAccount({ id: "acc-B", supplierTenantId: "supplier-B", buyerTenantId: "buyer-B", limitCents: 50_000, outstandingCents: 10_000 }),
  ],
  ledger: [
    seedDraw("acc-A", { id: "draw-A1", amountCents: 20_000, createdAt: new Date("2025-01-02T00:00:00Z") }),
    seedDraw("acc-B", { id: "draw-B1", amountCents: 10_000, createdAt: new Date("2025-01-03T00:00:00Z") }),
  ],
  // approveAccount is KYB-gated (w12): all test tenants are KYB-verified here
  // so the lifecycle tests exercise the account state machine, not the gate.
  kycApplications: ["supplier-A", "supplier-B", "buyer-A", "buyer-B", "buyer-req"].map((tenantId) =>
    seedKycApplication({ tenantId }),
  ),
});

vi.mock("./db", () => ({
  getDb: vi.fn(async () => fake.db),
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn(async () => true) }));
vi.mock("./kafka", () => ({
  publishOrderEvent: vi.fn().mockResolvedValue(undefined),
  publishConversationEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./dapr", () => ({
  daprPublish: vi.fn().mockResolvedValue(undefined),
  daprSaveState: vi.fn().mockResolvedValue(undefined),
}));

const { appRouter } = await import("./routers");

function makeCtx(role: "admin" | "user", tenantId?: string): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      tenantId: tenantId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}

const supplierA = () => appRouter.createCaller(makeCtx("user", "supplier-A"));
const buyerA = () => appRouter.createCaller(makeCtx("user", "buyer-A"));
const buyerB = () => appRouter.createCaller(makeCtx("user", "buyer-B"));
const buyerReq = () => appRouter.createCaller(makeCtx("user", "buyer-req"));
const admin = () => appRouter.createCaller(makeCtx("admin"));

beforeEach(() => {
  // Reset mutated account state between tests.
  const a = fake.store.accounts.find((r) => r.id === "acc-A")!;
  a.status = "active"; a.limitCents = 100_000; a.outstandingCents = 20_000;
  fake.store.ledger = fake.store.ledger.filter((l) => l.id === "draw-A1" || l.id === "draw-B1");
});

describe("tradeCredit router — supplier-side gating", () => {
  it("supplier can list its own accounts with aging buckets", async () => {
    const rows = await supplierA().tradeCredit.listAccounts({ supplierTenantId: "supplier-A" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("acc-A");
    expect(rows[0].aging.current + rows[0].aging.days1to30).toBeGreaterThanOrEqual(0);
  });

  it("tenant A cannot list tenant B's accounts (FORBIDDEN)", async () => {
    await expect(supplierA().tradeCredit.listAccounts({ supplierTenantId: "supplier-B" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("tenant A cannot freeze tenant B's account (input gate)", async () => {
    await expect(supplierA().tradeCredit.setAccountStatus({
      supplierTenantId: "supplier-B", accountId: "acc-B", status: "frozen",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.store.accounts.find((r) => r.id === "acc-B")!.status).toBe("active");
  });

  it("supplier passing its own tenantId but a foreign accountId gets NOT_FOUND (claim-first scoping)", async () => {
    await expect(supplierA().tradeCredit.setAccountStatus({
      supplierTenantId: "supplier-A", accountId: "acc-B", status: "frozen",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.store.accounts.find((r) => r.id === "acc-B")!.status).toBe("active");
  });

  it("supplier A cannot read account B's ledger even with a foreign accountId", async () => {
    await expect(supplierA().tradeCredit.accountLedger({
      supplierTenantId: "supplier-A", accountId: "acc-B",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("supplier can freeze and unfreeze its own account", async () => {
    const frozen = await supplierA().tradeCredit.setAccountStatus({
      supplierTenantId: "supplier-A", accountId: "acc-A", status: "frozen",
    });
    expect(frozen.status).toBe("frozen");
    const active = await supplierA().tradeCredit.setAccountStatus({
      supplierTenantId: "supplier-A", accountId: "acc-A", status: "active",
    });
    expect(active.status).toBe("active");
  });

  it("supplier can update limit/terms on its own account", async () => {
    const row = await supplierA().tradeCredit.updateAccount({
      supplierTenantId: "supplier-A", accountId: "acc-A", limitCents: 250_000, termsDays: 45,
    });
    expect(row.limitCents).toBe(250_000);
    expect(row.termsDays).toBe(45);
  });

  it("createAccount rejects a duplicate (supplier, buyer) pair with CONFLICT", async () => {
    await expect(supplierA().tradeCredit.createAccount({
      supplierTenantId: "supplier-A", buyerTenantId: "buyer-A", limitCents: 1_000,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("createAccount for a new pair succeeds", async () => {
    const row = await supplierA().tradeCredit.createAccount({
      supplierTenantId: "supplier-A", buyerTenantId: "buyer-Z", limitCents: 75_000, termsDays: 14,
    });
    expect(row.limitCents).toBe(75_000);
    expect(row.status).toBe("active");
    // cleanup
    fake.store.accounts = fake.store.accounts.filter((r) => r.buyerTenantId !== "buyer-Z");
  });

  it("recordRepayment over the outstanding is refused with BAD_REQUEST", async () => {
    await expect(supplierA().tradeCredit.recordRepayment({
      supplierTenantId: "supplier-A", accountId: "acc-A", amountCents: 20_001, ref: "r-over",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("recordRepayment applies a partial repayment and returns outstandingAfter", async () => {
    const res = await supplierA().tradeCredit.recordRepayment({
      supplierTenantId: "supplier-A", accountId: "acc-A", amountCents: 5_000, ref: "r-ok",
    });
    expect(res).toEqual({ ok: true, outstandingAfter: 15_000 });
  });
});

describe("tradeCredit router — buyer-side gating", () => {
  it("buyer sees only its own facilities", async () => {
    const rows = await buyerA().tradeCredit.myAccounts({ buyerTenantId: "buyer-A" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("acc-A");
    expect(rows[0].outstandingCents).toBe(20_000);
  });

  it("buyer A cannot query buyer B's accounts (FORBIDDEN)", async () => {
    await expect(buyerA().tradeCredit.myAccounts({ buyerTenantId: "buyer-B" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("buyer A cannot read account B's ledger (NOT_FOUND via ownership check)", async () => {
    await expect(buyerA().tradeCredit.myLedger({ buyerTenantId: "buyer-A", accountId: "acc-B" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("buyer reads its own ledger", async () => {
    const rows = await buyerA().tradeCredit.myLedger({ buyerTenantId: "buyer-A", accountId: "acc-A" });
    expect(rows.some((l) => l.id === "draw-A1")).toBe(true);
  });

  it("requestLimitIncrease writes a zero-amount adjustment note the supplier can see", async () => {
    const entry = await buyerA().tradeCredit.requestLimitIncrease({
      buyerTenantId: "buyer-A", accountId: "acc-A", requestedLimitCents: 500_000, note: "Q3 seasonal spike",
    });
    expect(entry.kind).toBe("adjustment");
    expect(entry.amountCents).toBe(0);
    expect(entry.note).toContain("500000");
    const supplierLedger = await supplierA().tradeCredit.accountLedger({
      supplierTenantId: "supplier-A", accountId: "acc-A",
    });
    expect(supplierLedger.some((l) => l.id === entry.id)).toBe(true);
  });

  it("buyer B cannot request an increase on buyer A's account", async () => {
    await expect(buyerB().tradeCredit.requestLimitIncrease({
      buyerTenantId: "buyer-B", accountId: "acc-A", requestedLimitCents: 1,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("unauthenticated callers are rejected", async () => {
    const anon = appRouter.createCaller({ user: null, req: {}, res: {} } as unknown as TrpcContext);
    await expect(anon.tradeCredit.myAccounts({ buyerTenantId: "buyer-A" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("platform admin bypasses tenant scoping (defense-in-depth role)", async () => {
    const rows = await admin().tradeCredit.listAccounts({ supplierTenantId: "supplier-B" });
    expect(rows).toHaveLength(1);
  });
});

describe("tradeCredit requestAccount → approve lifecycle", () => {
  const cleanup = () => {
    fake.store.accounts = fake.store.accounts.filter((r) => r.buyerTenantId !== "buyer-req");
    fake.store.ledger = fake.store.ledger.filter((l) => l.id === "draw-A1" || l.id === "draw-B1");
  };

  it("buyer requestAccount lands as 'pending' with zero limit; supplier sees it in listAccounts", async () => {
    const row = await buyerReq().tradeCredit.requestAccount({
      buyerTenantId: "buyer-req", supplierTenantId: "supplier-A", note: "please",
    });
    expect(row.status).toBe("pending");
    expect(row.limitCents).toBe(0);
    const list = await supplierA().tradeCredit.listAccounts({ supplierTenantId: "supplier-A" });
    expect(list.some((a) => a.id === row.id && a.status === "pending")).toBe(true);
    cleanup();
  });

  it("requestAccount for an existing pair is CONFLICT (any status)", async () => {
    await expect(buyerA().tradeCredit.requestAccount({
      buyerTenantId: "buyer-A", supplierTenantId: "supplier-A",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a pending account can NEVER draw — drawOnCredit's claim requires status='active' (draw.ts)", async () => {
    const row = await buyerReq().tradeCredit.requestAccount({
      buyerTenantId: "buyer-req", supplierTenantId: "supplier-A",
    });
    const { drawOnCreditTx } = await import("./services/tradeCredit/draw");
    const res = await drawOnCreditTx(fake.db, {
      supplierTenantId: "supplier-A", buyerTenantId: "buyer-req", amountCents: 1, poId: "po-pending",
    });
    expect(res.ok).toBe(false); // guard miss: status='pending' ≠ 'active'
    expect(fake.store.accounts.find((a) => a.id === row.id)!.outstandingCents).toBe(0);
    expect(fake.store.ledger.some((l) => l.poId === "po-pending")).toBe(false);
    cleanup();
  });

  it("supplier approveAccount flips pending → active with limit/terms, then a draw succeeds", async () => {
    const row = await buyerReq().tradeCredit.requestAccount({
      buyerTenantId: "buyer-req", supplierTenantId: "supplier-A",
    });
    const approved = await supplierA().tradeCredit.approveAccount({
      supplierTenantId: "supplier-A", accountId: row.id, limitCents: 300_000, termsDays: 60,
    });
    expect(approved.status).toBe("active");
    expect(approved.limitCents).toBe(300_000);
    expect(approved.termsDays).toBe(60);
    const { drawOnCreditTx } = await import("./services/tradeCredit/draw");
    const draw = await drawOnCreditTx(fake.db, {
      supplierTenantId: "supplier-A", buyerTenantId: "buyer-req", amountCents: 40_000, poId: "po-ok",
    });
    expect(draw).toMatchObject({ ok: true, outstandingAfter: 40_000 });
    cleanup();
  });

  it("approveAccount is claim-first: a second approve (or non-pending account) is NOT_FOUND", async () => {
    const row = await buyerReq().tradeCredit.requestAccount({
      buyerTenantId: "buyer-req", supplierTenantId: "supplier-A",
    });
    await supplierA().tradeCredit.approveAccount({ supplierTenantId: "supplier-A", accountId: row.id });
    await expect(supplierA().tradeCredit.approveAccount({
      supplierTenantId: "supplier-A", accountId: row.id,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Active accounts are not re-approvable either.
    await expect(supplierA().tradeCredit.approveAccount({
      supplierTenantId: "supplier-A", accountId: "acc-A",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    cleanup();
  });

  it("authZ: a supplier cannot create/approve pending accounts cross-tenant", async () => {
    // requestAccount is buyer-gated: supplier-A posing as buyer-A is FORBIDDEN at the input gate.
    await expect(supplierA().tradeCredit.requestAccount({
      buyerTenantId: "buyer-A", supplierTenantId: "supplier-A",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // And supplier-B cannot approve supplier-A's pending account even with the id.
    const row = await buyerReq().tradeCredit.requestAccount({
      buyerTenantId: "buyer-req", supplierTenantId: "supplier-A",
    });
    await expect(supplierA().tradeCredit.approveAccount({
      supplierTenantId: "supplier-B", accountId: row.id,
    })).rejects.toMatchObject({ code: "FORBIDDEN" }); // input gate
    const supplierBCaller = appRouter.createCaller(makeCtx("user", "supplier-B"));
    await expect(supplierBCaller.tradeCredit.approveAccount({
      supplierTenantId: "supplier-B", accountId: row.id,
    })).rejects.toMatchObject({ code: "NOT_FOUND" }); // claim-first scoping
    expect(fake.store.accounts.find((a) => a.id === row.id)!.status).toBe("pending");
    cleanup();
  });
});
