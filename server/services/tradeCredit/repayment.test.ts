/**
 * applyRepayment — claim-first decrement, partial repayment, over-repay
 * refusal, FIFO draw settlement.
 */
import { describe, it, expect } from "vitest";
import { applyRepaymentTx } from "./repayment";
import { makeFakeDb, seedAccount, seedDraw } from "./fakeDb";

const T = (d: string) => new Date(`${d}T00:00:00Z`);

describe("applyRepaymentTx", () => {
  it("full repayment zeroes outstanding and settles covered draws", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const draw = seedDraw(account.id, { amountCents: 10_000, createdAt: T("2025-01-02") });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 10_000, ref: "pay-1" });
    expect(res).toEqual({ ok: true, outstandingAfter: 0 });
    expect(store.accounts[0].outstandingCents).toBe(0);
    expect(store.ledger.find((l) => l.kind === "repayment")).toMatchObject({ amountCents: 10_000, ref: "pay-1" });
    expect(store.ledger.find((l) => l.id === draw.id)?.status).toBe("settled");
  });

  it("partial repayment decrements outstanding; partially-covered draw stays posted", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const draw = seedDraw(account.id, { amountCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-partial" });
    expect(res).toEqual({ ok: true, outstandingAfter: 6_000 });
    expect(store.ledger.find((l) => l.id === draw.id)?.status).toBe("posted");
  });

  it("two partial repayments cumulatively settle the draw (FIFO pool)", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const draw = seedDraw(account.id, { amountCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    await applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-a" });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 6_000, ref: "pay-b" });
    expect(res).toEqual({ ok: true, outstandingAfter: 0 });
    expect(store.ledger.find((l) => l.id === draw.id)?.status).toBe("settled");
  });

  it("over-repayment is refused atomically — no decrement, no ledger row", async () => {
    const account = seedAccount({ outstandingCents: 5_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 5_001, ref: "pay-over" });
    expect(res).toEqual({ ok: false, outstandingAfter: 5_000 });
    expect(store.accounts[0].outstandingCents).toBe(5_000);
    expect(store.ledger).toHaveLength(0);
  });

  it("repayment against a missing account is refused", async () => {
    const { db } = makeFakeDb();
    const res = await applyRepaymentTx(db, { accountId: "no-such", amountCents: 1_000, ref: "pay-x" });
    expect(res).toEqual({ ok: false, outstandingAfter: 0 });
  });

  it("non-positive amounts are refused", async () => {
    const account = seedAccount({ outstandingCents: 5_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    expect((await applyRepaymentTx(db, { accountId: account.id, amountCents: 0, ref: "r0" })).ok).toBe(false);
    expect((await applyRepaymentTx(db, { accountId: account.id, amountCents: -10, ref: "r1" })).ok).toBe(false);
    expect(store.accounts[0].outstandingCents).toBe(5_000);
  });

  it("FIFO settlement: oldest draws settle first, newer stays posted", async () => {
    const account = seedAccount({ outstandingCents: 30_000 });
    const d1 = seedDraw(account.id, { id: "d1", amountCents: 10_000, createdAt: T("2025-01-02") });
    const d2 = seedDraw(account.id, { id: "d2", amountCents: 10_000, createdAt: T("2025-01-03") });
    const d3 = seedDraw(account.id, { id: "d3", amountCents: 10_000, createdAt: T("2025-01-04") });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [d3, d1, d2] }); // unordered seed
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 20_000, ref: "pay-fifo" });
    expect(res).toEqual({ ok: true, outstandingAfter: 10_000 });
    const byId = Object.fromEntries(store.ledger.map((l) => [l.id, l]));
    expect(byId["d1"].status).toBe("settled");
    expect(byId["d2"].status).toBe("settled");
    expect(byId["d3"].status).toBe("posted");
  });

  it("already-settled draws are never re-settled or double-counted", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const settled = seedDraw(account.id, { id: "ds", amountCents: 10_000, status: "settled", createdAt: T("2025-01-02") });
    const posted = seedDraw(account.id, { id: "dp", amountCents: 10_000, createdAt: T("2025-01-03") });
    // Historical repayment that originally settled ds — it must consume pool.
    const historical = seedDraw(account.id, {
      id: "rh", kind: "repayment", amountCents: 10_000, status: "posted",
      dueDate: null, createdAt: T("2025-01-05"),
    });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [settled, posted, historical] });
    await applyRepaymentTx(db, { accountId: account.id, amountCents: 10_000, ref: "pay-2" });
    const byId = Object.fromEntries(store.ledger.map((l) => [l.id, l]));
    expect(byId["ds"].status).toBe("settled");
    expect(byId["dp"].status).toBe("settled");
  });

  it("settled draws consume their share — historical repayment cannot settle a new draw twice", async () => {
    // ds (10k) was settled by rh (10k). A new 10k draw with NO new repayment
    // must stay posted even though a repayment row exists in the ledger.
    const account = seedAccount({ outstandingCents: 10_000 });
    const settled = seedDraw(account.id, { id: "ds", amountCents: 10_000, status: "settled", createdAt: T("2025-01-02") });
    const historical = seedDraw(account.id, {
      id: "rh", kind: "repayment", amountCents: 10_000, status: "posted",
      dueDate: null, createdAt: T("2025-01-05"),
    });
    const posted = seedDraw(account.id, { id: "dp", amountCents: 10_000, createdAt: T("2025-01-06") });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [settled, historical, posted] });
    // Repay 1 cent... would be refused (0 < 1). Instead verify via a tiny top-up:
    const res = await applyRepaymentTx(db, { accountId: account.id, amountCents: 9_999, ref: "pay-most" });
    expect(res).toEqual({ ok: true, outstandingAfter: 1 });
    // pool = 10_000 (rh) + 9_999 = 19_999; ds consumes 10_000; dp needs 10_000 > 9_999 → posted.
    expect(store.ledger.find((l) => l.id === "dp")?.status).toBe("posted");
  });

  it("concurrent repayments cannot push outstanding below zero", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const results = await Promise.all([
      applyRepaymentTx(db, { accountId: account.id, amountCents: 7_000, ref: "r1" }),
      applyRepaymentTx(db, { accountId: account.id, amountCents: 7_000, ref: "r2" }),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(store.accounts[0].outstandingCents).toBe(3_000);
    expect(store.accounts[0].outstandingCents).toBeGreaterThanOrEqual(0);
  });
});

describe("W14.1 — repayment ref dedupe (0052 unique index)", () => {
  it("same ref twice → second call is an idempotent alreadySettled no-op", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const first = await applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-dupe" });
    expect(first).toEqual({ ok: true, outstandingAfter: 6_000 });
    const second = await applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-dupe" });
    expect(second).toEqual({ ok: true, outstandingAfter: 6_000, alreadySettled: true });
    // Exactly one repayment row; outstanding decremented exactly once
    // (the loser's transaction rolled back the claim).
    expect(store.ledger.filter((l) => l.kind === "repayment" && l.ref === "pay-dupe")).toHaveLength(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });

  it("concurrent same-ref repayments settle exactly once", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const results = await Promise.all([
      applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-race" }),
      applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-race" }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.alreadySettled)).toHaveLength(1);
    expect(store.ledger.filter((l) => l.kind === "repayment" && l.ref === "pay-race")).toHaveLength(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });

  it("different refs are NOT deduped — both apply", async () => {
    const account = seedAccount({ outstandingCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const a = await applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-a" });
    const b = await applyRepaymentTx(db, { accountId: account.id, amountCents: 4_000, ref: "pay-b" });
    expect(a).toMatchObject({ ok: true, outstandingAfter: 6_000 });
    expect(b).toMatchObject({ ok: true, outstandingAfter: 2_000 });
    expect(b.alreadySettled).toBeUndefined();
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(2);
    expect(store.accounts[0].outstandingCents).toBe(2_000);
  });

  it("the dedupe index is per-account: same ref on another account applies", async () => {
    const a1 = seedAccount({ id: "acct-a", outstandingCents: 10_000 });
    const a2 = seedAccount({ id: "acct-b", outstandingCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [a1, a2] });
    await applyRepaymentTx(db, { accountId: "acct-a", amountCents: 4_000, ref: "pay-shared" });
    const res = await applyRepaymentTx(db, { accountId: "acct-b", amountCents: 4_000, ref: "pay-shared" });
    expect(res).toEqual({ ok: true, outstandingAfter: 6_000 });
    expect(store.ledger.filter((l) => l.kind === "repayment" && l.ref === "pay-shared")).toHaveLength(2);
  });
});
