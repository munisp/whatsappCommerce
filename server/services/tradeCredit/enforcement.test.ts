/**
 * W13 credit control plane — order-access suspension lifecycle, dunning +7d
 * auto-suspend, repayment auto-lift, and the settleDrawToSupplier contract.
 */
import { describe, it, expect } from "vitest";
import { makeFakeDb, seedAccount, seedDraw, seedPurchaseOrder } from "./fakeDb";
import {
  isOrderAccessSuspendedTx,
  liftOrderAccessTx,
  settleDrawToSupplierTx,
  suspendOrderAccessTx,
} from "./enforcement";
import { applyRepaymentTx } from "./repayment";
import { runDunningCheckTx, FREEZE_AFTER_DAYS } from "./dunning";

const NOW = new Date("2025-03-10T12:00:00Z");

describe("suspendOrderAccess / isOrderAccessSuspended", () => {
  it("suspends an account claim-first and records reason + timestamp", async () => {
    const account = seedAccount({ id: "acct-1" });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await suspendOrderAccessTx(db, {
      buyerTenantId: "buyer-1",
      supplierTenantId: "supplier-1",
      reason: "manual_review",
    }, NOW);
    expect(res).toEqual({ ok: true, changed: true });
    expect(store.accounts[0]).toMatchObject({
      suspended: true,
      suspendedAt: NOW,
      suspensionReason: "manual_review",
    });
    expect(await isOrderAccessSuspendedTx(db, "buyer-1", "supplier-1")).toBe(true);
  });

  it("is idempotent — a second suspend reports changed:false and keeps the first reason", async () => {
    const account = seedAccount({ id: "acct-1" });
    const { db, store } = makeFakeDb({ accounts: [account] });
    await suspendOrderAccessTx(db, { buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", reason: "first" });
    const res = await suspendOrderAccessTx(db, { buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", reason: "second" });
    expect(res).toEqual({ ok: true, changed: false });
    expect(store.accounts[0].suspensionReason).toBe("first");
  });

  it("fails closed when no facility exists; isOrderAccessSuspended is false", async () => {
    const { db } = makeFakeDb();
    const res = await suspendOrderAccessTx(db, { buyerTenantId: "b", supplierTenantId: "s", reason: "x" });
    expect(res).toEqual({ ok: false, changed: false, reason: "no_account" });
    expect(await isOrderAccessSuspendedTx(db, "b", "s")).toBe(false);
  });

  it("unsuspended accounts report false", async () => {
    const { db } = makeFakeDb({ accounts: [seedAccount()] });
    expect(await isOrderAccessSuspendedTx(db, "buyer-1", "supplier-1")).toBe(false);
  });

  it("lift clears the suspension fields claim-first", async () => {
    const account = seedAccount({ id: "acct-1", suspended: true, suspensionReason: "r", suspendedAt: NOW });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await liftOrderAccessTx(db, { buyerTenantId: "buyer-1", supplierTenantId: "supplier-1" });
    expect(res).toEqual({ ok: true, changed: true });
    expect(store.accounts[0]).toMatchObject({ suspended: false, suspendedAt: null, suspensionReason: null });
    const again = await liftOrderAccessTx(db, { buyerTenantId: "buyer-1", supplierTenantId: "supplier-1" });
    expect(again.changed).toBe(false);
  });
});

describe("dunning +7d auto-suspend", () => {
  it("freeze at +7d also suspends order access", async () => {
    const dueDate = new Date(NOW.getTime() - (FREEZE_AFTER_DAYS + 1) * 24 * 3600 * 1000);
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000 });
    const draw = seedDraw("acct-1", { dueDate });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await runDunningCheckTx(db, NOW);
    expect(res.frozen).toBe(1);
    expect(store.accounts[0].status).toBe("frozen");
    expect(store.accounts[0].suspended).toBe(true);
    expect(store.accounts[0].suspensionReason).toBe("dunning_freeze_+7d");
    expect(await isOrderAccessSuspendedTx(db, "buyer-1", "supplier-1")).toBe(true);
  });

  it("does not suspend before the freeze milestone (+3d fee only)", async () => {
    const dueDate = new Date(NOW.getTime() - 4 * 24 * 3600 * 1000);
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000 });
    const draw = seedDraw("acct-1", { dueDate });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await runDunningCheckTx(db, NOW);
    expect(res.frozen).toBe(0);
    expect(store.accounts[0].suspended).toBe(false);
  });
});

describe("repayment auto-lift", () => {
  it("lifts the suspension when outstanding returns to 0", async () => {
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000, suspended: true, suspensionReason: "dunning_freeze_+7d", suspendedAt: NOW });
    const draw = seedDraw("acct-1", { amountCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await applyRepaymentTx(db, { accountId: "acct-1", amountCents: 10_000, ref: "cr-1" });
    expect(res.ok).toBe(true);
    expect(store.accounts[0].suspended).toBe(false);
    expect(store.accounts[0].suspensionReason).toBeNull();
  });

  it("keeps the suspension while a balance remains", async () => {
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000, suspended: true, suspensionReason: "r" });
    const draw = seedDraw("acct-1", { amountCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    await applyRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000, ref: "cr-1" });
    expect(store.accounts[0].suspended).toBe(true);
  });
});

describe("settleDrawToSupplier", () => {
  const drawResult = { ok: true as const, ledgerId: "led-1", outstandingAfter: 10_000 };

  it("marks an invoiced credit PO paid-via-credit (claim-first)", async () => {
    const po = seedPurchaseOrder({ id: "po-1", status: "invoiced" });
    const { db, store } = makeFakeDb({ purchaseOrders: [po] });
    const res = await settleDrawToSupplierTx(db, { poId: "po-1", drawResult });
    expect(res).toEqual({ ok: true, action: "paid" });
    expect(store.purchaseOrders[0].status).toBe("paid");
    expect(store.purchaseOrders[0].notes).toContain("led-1");
  });

  it("is idempotent — an already-paid PO reports already_paid", async () => {
    const po = seedPurchaseOrder({ id: "po-1", status: "paid" });
    const { db } = makeFakeDb({ purchaseOrders: [po] });
    expect(await settleDrawToSupplierTx(db, { poId: "po-1", drawResult })).toEqual({ ok: true, action: "already_paid" });
  });

  it("fails closed on wrong status / unknown PO / missing draw", async () => {
    const po = seedPurchaseOrder({ id: "po-1", status: "submitted" });
    const { db } = makeFakeDb({ purchaseOrders: [po] });
    expect(await settleDrawToSupplierTx(db, { poId: "po-1", drawResult })).toEqual({ ok: false, action: "wrong_status:submitted" });
    expect(await settleDrawToSupplierTx(db, { poId: "nope", drawResult })).toEqual({ ok: false, action: "not_found" });
    expect(await settleDrawToSupplierTx(db, { poId: "po-1", drawResult: undefined as any })).toEqual({ ok: false, action: "no_draw" });
  });
});
