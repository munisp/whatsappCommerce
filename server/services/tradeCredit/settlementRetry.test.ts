/**
 * W14 — retrySettlement: admin-invokable exactly-once re-attempt of a
 * charge-success/settle-fail repayment.
 *
 *   - settles via the claim-first FIFO path with the SAME reference;
 *   - exactly-once: a second call finds the repayment ledger row and no-ops
 *     ('already_settled') — outstanding is decremented exactly once;
 *   - the pending amount is recovered from the durable settlement_retry
 *     marker (zero-amount 'adjustment' ledger note claimed delete-first);
 *   - a refused retry restores the marker so the gap stays retryable;
 *   - unknown references fail closed with 'no_pending_retry'.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeFakeDb, seedAccount, seedDraw, type LedgerRow } from "./fakeDb";
import { retrySettlement } from "./capture";
import { __setDunningNoticeForTests } from "./capture";
import { _resetRecentErrors } from "../observability";

const NOW = new Date("2025-03-10T12:00:00Z");
const REF = "cr-acct-1-20250310-000001";

function retryMarker(accountId: string, amountCents: number, ref: string = REF): LedgerRow {
  return {
    id: `marker-${ref}`,
    creditAccountId: accountId,
    kind: "adjustment",
    amountCents: 0,
    poId: null,
    dueDate: null,
    status: "posted",
    ref,
    note: `[settlement_retry] {"amountCents":${amountCents}}`,
    createdAt: NOW,
  };
}

function seedPending(opts: { outstanding?: number; markerAmount?: number } = {}) {
  const account = seedAccount({ id: "acct-1", outstandingCents: opts.outstanding ?? 10_000 });
  const draw = seedDraw("acct-1", { amountCents: 10_000 });
  const marker = retryMarker("acct-1", opts.markerAmount ?? 4_000);
  const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw, marker] });
  return { db, store };
}

afterEach(() => {
  __setDunningNoticeForTests(null);
  _resetRecentErrors();
});

describe("retrySettlement", () => {
  it("settles the pending repayment with the original reference (FIFO, marker consumed)", async () => {
    const { db, store } = seedPending();
    const res = await retrySettlement(db, { accountId: "acct-1", reference: REF }, NOW);
    expect(res).toMatchObject({ ok: true, status: "settled", reference: REF, outstandingAfter: 6_000 });
    expect(store.accounts[0].outstandingCents).toBe(6_000);
    const rep = store.ledger.filter((l) => l.kind === "repayment");
    expect(rep).toHaveLength(1);
    expect(rep[0].ref).toBe(REF);
    // Marker claimed (deleted) — no pending retry remains.
    expect(store.ledger.some((l) => (l.note ?? "").startsWith("[settlement_retry] "))).toBe(false);
  });

  it("is idempotent: a double-call settles exactly once ('already_settled' no-op)", async () => {
    const { db, store } = seedPending();
    const first = await retrySettlement(db, { accountId: "acct-1", reference: REF }, NOW);
    expect(first.status).toBe("settled");
    const second = await retrySettlement(db, { accountId: "acct-1", reference: REF }, NOW);
    expect(second).toMatchObject({ ok: true, status: "already_settled", reference: REF });
    // Exactly one repayment row and one decrement across both calls.
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });

  it("cleans a lingering marker when the reference is already settled", async () => {
    const { db, store } = seedPending();
    // Simulate: repayment landed (via the original attempt) but the marker
    // row was left behind.
    store.ledger.push({
      id: "rep-1",
      creditAccountId: "acct-1",
      kind: "repayment",
      amountCents: 4_000,
      poId: null,
      dueDate: null,
      status: "posted",
      ref: REF,
      note: null,
      createdAt: NOW,
    });
    const res = await retrySettlement(db, { accountId: "acct-1", reference: REF }, NOW);
    expect(res.status).toBe("already_settled");
    expect(store.ledger.some((l) => (l.note ?? "").startsWith("[settlement_retry] "))).toBe(false);
    // No second repayment applied.
    expect(store.accounts[0].outstandingCents).toBe(10_000);
  });

  it("applies strict FIFO: a partial retry leaves the draw posted", async () => {
    const { db, store } = seedPending({ outstanding: 4_000, markerAmount: 4_000 });
    const res = await retrySettlement(db, { accountId: "acct-1", reference: REF }, NOW);
    expect(res.status).toBe("settled");
    expect(store.accounts[0].outstandingCents).toBe(0);
    // Draw amount 10_000 > repaid pool 4_000 → still posted (partial cover).
    expect(store.ledger.find((l) => l.kind === "invoice_draw")?.status).toBe("posted");
  });

  it("a refused retry (amount now exceeds outstanding) restores the marker", async () => {
    const { db, store } = seedPending({ outstanding: 3_000, markerAmount: 4_000 });
    const res = await retrySettlement(db, { accountId: "acct-1", reference: REF }, NOW);
    expect(res).toMatchObject({ ok: false, status: "settlement_refused", reference: REF, outstandingAfter: 3_000 });
    // Marker restored with the same pending amount — still retryable.
    const marker = store.ledger.find((l) => (l.note ?? "").startsWith("[settlement_retry] "));
    expect(marker).toBeDefined();
    expect(marker!.ref).toBe(REF);
    expect(marker!.note).toContain('"amountCents":4000');
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(0);
  });

  it("fails closed with 'no_pending_retry' for an unknown reference", async () => {
    const { db, store } = seedPending();
    const res = await retrySettlement(db, { accountId: "acct-1", reference: "cr-acct-1-20250310-999999" }, NOW);
    expect(res).toMatchObject({ ok: false, status: "no_pending_retry" });
    expect(store.accounts[0].outstandingCents).toBe(10_000);
  });

  it("uses the admin-supplied amount when no marker exists (explicit override)", async () => {
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000 });
    const draw = seedDraw("acct-1", { amountCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const res = await retrySettlement(db, { accountId: "acct-1", reference: REF, amountCents: 2_500 }, NOW);
    expect(res).toMatchObject({ ok: true, status: "settled", outstandingAfter: 7_500 });
    expect(store.accounts[0].outstandingCents).toBe(7_500);
  });

  it("never throws on malformed input", async () => {
    const { db } = seedPending();
    const res = await retrySettlement(db, { accountId: "", reference: "" }, NOW);
    expect(res.ok).toBe(false);
  });
});

describe("W14.1 — retrySettlement double-settle race (0052 unique index)", () => {
  // The W14 verifier finding: when the settlement_retry marker persist
  // silently fails, two concurrent admin retries with an explicit amountCents
  // both pass the marker claim and step-1 read. The partial unique index on
  // (credit_account_id, ref) makes the second insert fail; applyRepaymentTx
  // translates 23505 into an idempotent already-settled no-op.
  it("concurrent retries with explicit amountCents settle exactly once", async () => {
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000 });
    const draw = seedDraw("acct-1", { amountCents: 10_000 });
    // NO settlement_retry marker — simulates the silent persist failure.
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const results = await Promise.all([
      retrySettlement(db, { accountId: "acct-1", reference: REF, amountCents: 4_000 }, NOW),
      retrySettlement(db, { accountId: "acct-1", reference: REF, amountCents: 4_000 }, NOW),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["already_settled", "settled"]);
    expect(results.every((r) => r.ok)).toBe(true);
    // Exactly one repayment row; outstanding decremented exactly once.
    expect(store.ledger.filter((l) => l.kind === "repayment" && l.ref === REF)).toHaveLength(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });

  it("a retry losing the insert race reports already_settled and cleans no marker that isn't there", async () => {
    const account = seedAccount({ id: "acct-1", outstandingCents: 10_000 });
    const draw = seedDraw("acct-1", { amountCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw] });
    const first = await retrySettlement(db, { accountId: "acct-1", reference: REF, amountCents: 4_000 }, NOW);
    expect(first.status).toBe("settled");
    // Sequential second call hits the step-1 read guard (same end state).
    const second = await retrySettlement(db, { accountId: "acct-1", reference: REF, amountCents: 4_000 }, NOW);
    expect(second).toMatchObject({ ok: true, status: "already_settled" });
    expect(store.ledger.filter((l) => l.kind === "repayment" && l.ref === REF)).toHaveLength(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
  });
});
