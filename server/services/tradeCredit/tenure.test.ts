/**
 * W13 tenure gate — the FIRST draw on a facility requires the account to be
 * aged ≥ CREDIT_TENURE_GATE_DAYS (default 7), unless the supplier overrides.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeFakeDb, seedAccount, seedDraw } from "./fakeDb";
import { drawOnCreditTx, tenureGateDays } from "./draw";

const NOW = new Date("2025-03-10T12:00:00Z");
const DAY = 24 * 3600 * 1000;

afterEach(() => {
  delete process.env.CREDIT_TENURE_GATE_DAYS;
});

function youngAccount(extraLedger: any[] = []) {
  const account = seedAccount({ id: "acct-1", createdAt: new Date(NOW.getTime() - 2 * DAY) });
  return makeFakeDb({ accounts: [account], ledger: extraLedger });
}

describe("tenureGateDays env parsing", () => {
  it("defaults to 7, honors a numeric override, falls back on garbage", () => {
    expect(tenureGateDays({} as any)).toBe(7);
    expect(tenureGateDays({ CREDIT_TENURE_GATE_DAYS: "14" } as any)).toBe(14);
    expect(tenureGateDays({ CREDIT_TENURE_GATE_DAYS: "0" } as any)).toBe(0);
    expect(tenureGateDays({ CREDIT_TENURE_GATE_DAYS: "banana" } as any)).toBe(7);
  });
});

describe("drawOnCreditTx tenure gate", () => {
  it("blocks the first draw on an account younger than the gate", async () => {
    const { db, store } = youngAccount();
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-1",
    }, NOW);
    expect(res).toEqual({ ok: false, reason: "frozen", blockedBy: "tenure" });
    expect(store.accounts[0].outstandingCents).toBe(0);
    expect(store.ledger).toHaveLength(0);
  });

  it("allows the first draw once the account is aged past the gate", async () => {
    const account = seedAccount({ id: "acct-1", createdAt: new Date(NOW.getTime() - 8 * DAY) });
    const { db } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-1",
    }, NOW);
    expect(res.ok).toBe(true);
  });

  it("honors an explicit supplier override", async () => {
    const { db } = youngAccount();
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-1", tenureOverride: true,
    }, NOW);
    expect(res.ok).toBe(true);
  });

  it("applies only to the FIRST draw — a facility with history is exempt", async () => {
    const prior = seedDraw("acct-1", { amountCents: 500 });
    const account = seedAccount({ id: "acct-1", createdAt: new Date(NOW.getTime() - 2 * DAY), outstandingCents: 500 });
    const { db } = makeFakeDb({ accounts: [account], ledger: [prior] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-2",
    }, NOW);
    expect(res.ok).toBe(true);
  });

  it("CREDIT_TENURE_GATE_DAYS=0 disables the gate (dev/test override)", async () => {
    process.env.CREDIT_TENURE_GATE_DAYS = "0";
    const { db } = youngAccount();
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-1",
    }, NOW);
    expect(res.ok).toBe(true);
  });

  it("a longer env gate still blocks", async () => {
    process.env.CREDIT_TENURE_GATE_DAYS = "30";
    const { db } = youngAccount();
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-1",
    }, NOW);
    expect(res.ok).toBe(false);
  });
});

describe("drawOnCreditTx suspension refusal", () => {
  it("refuses draws on suspended accounts", async () => {
    const account = seedAccount({ id: "acct-1", suspended: true, suspensionReason: "dunning_freeze_+7d" });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 1_000, poId: "po-1",
    }, NOW);
    expect(res).toEqual({ ok: false, reason: "frozen", blockedBy: "suspended" });
    expect(store.ledger).toHaveLength(0);
  });
});
