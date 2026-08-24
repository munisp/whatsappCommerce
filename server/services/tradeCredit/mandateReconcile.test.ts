/**
 * A1-02 / F-03 regression — mandate charge pending-status semantics +
 * fetchStatus reconciliation (never a blind re-charge).
 *
 * Pre-fix defects:
 *  - a mandate charge returning status 'pending' was SETTLED immediately
 *    (outstanding reduced before money moved); a pending-then-failed charge
 *    left the book permanently under-collected;
 *  - mandate charges were persisted nowhere — no sweep could ever resolve
 *    them;
 *  - timeout-after-send was treated as failure: claim released, buyer dunned
 *    to pay again → double collection when the charge had succeeded.
 *
 * Post-fix: pending ⇒ no settlement + durable mandate_charges row;
 * reconcilePendingMandateCharges settles exactly once on provider-confirmed
 * success (double-sweep safe), releases the claim on definitive failure,
 * and leaves unknown/timeout rows for the next sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeFakeDb, seedAccount, seedDraw, seedMandate, seedMandateCharge } from "./fakeDb";
import {
  __setDunningNoticeForTests,
  applyMandateRepaymentTx,
  reconcilePendingMandateCharges,
} from "./capture";
import { __setMandateProvidersForTests } from "../payments/mandates";

const NOW = new Date("2025-03-10T12:00:00Z");
const LATER = new Date("2025-03-11T12:00:00Z");

function providerWith(chargeImpl: () => Promise<any>, fetchImpl?: () => Promise<any>) {
  return {
    provider: {
      id: "paystack",
      displayName: "Paystack",
      supportsMandates: true,
      initiate: vi.fn(),
      verifyWebhook: vi.fn(),
      fetchStatus: vi.fn(fetchImpl ?? (async () => ({ status: "success" as const, amountCents: 4_000 }))),
      testConnection: vi.fn(),
      createMandate: vi.fn(),
      chargeMandate: vi.fn(chargeImpl),
      revokeMandate: vi.fn(),
    },
    creds: {},
    config: { priority: 1 },
  };
}

function seedWithMandate(over: Record<string, unknown> = {}) {
  const mandate = seedMandate({ id: "m-1", provider: "paystack", status: "active" });
  const account = seedAccount({
    id: "acct-1", mandateId: "m-1", outstandingCents: 10_000, limitCents: 100_000, ...over,
  });
  const draw = seedDraw("acct-1", { amountCents: 10_000 });
  const { db, store } = makeFakeDb({ accounts: [account], ledger: [draw], mandates: [mandate] });
  return { db, store, account, mandate };
}

afterEach(() => {
  __setMandateProvidersForTests(null);
  __setDunningNoticeForTests(null);
});
beforeEach(() => vi.clearAllMocks());

describe("pending mandate charge — no premature settlement (A1-02)", () => {
  it("status 'pending' does NOT settle: outstanding unchanged, durable pending row, truthful result", async () => {
    const { db, store } = seedWithMandate();
    const entry = providerWith(async (ctx: any) => ({
      ok: true, reference: ctx.reference, status: "pending" as const, provider: "paystack",
    }));
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(res).toMatchObject({ ok: true, mode: "mandate", status: "pending", outstandingAfter: 10_000 });
    // No settlement: outstanding unchanged, no repayment ledger row.
    expect(store.accounts[0].outstandingCents).toBe(10_000);
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(0);
    // Durable pending charge row keyed by the exactly-once reference.
    expect(store.mandateCharges).toHaveLength(1);
    expect(store.mandateCharges[0]).toMatchObject({
      accountId: "acct-1", provider: "paystack", status: "pending", amountCents: 4_000,
    });
    expect(store.mandateCharges[0].reference).toMatch(/^cr-acct-1-/);
    // The exactly-once claim is KEPT — the charge is never retried.
    expect(store.webhookEvents.filter((e: any) => e.type === "credit_repayment")).toHaveLength(1);
    expect(store.webhookEvents.filter((e: any) => e.type === "credit_repayment_pending")).toHaveLength(1); // W30 pending marker kept
  });

  it("pending → success sweep settles EXACTLY ONCE, even across a double sweep", async () => {
    const { db, store } = seedWithMandate();
    const entry = providerWith(
      async (ctx: any) => ({ ok: true, reference: ctx.reference, status: "pending" as const, provider: "paystack" }),
      async () => ({ status: "success" as const, amountCents: 4_000 }),
    );
    __setMandateProvidersForTests(async () => [entry] as any);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(res.status).toBe("pending");
    const reference = (res as any).reference as string;

    const sweep1 = await reconcilePendingMandateCharges(db, {}, LATER);
    expect(sweep1).toMatchObject({ checked: 1, settled: 1, failed: 0, stillPending: 0 });
    expect(store.accounts[0].outstandingCents).toBe(6_000);
    expect(store.ledger.filter((l) => l.kind === "repayment" && l.ref === reference)).toHaveLength(1);
    expect(store.mandateCharges[0].status).toBe("success");
    // fetchStatus used, chargeMandate called exactly once (no re-charge).
    expect(entry.provider.fetchStatus).toHaveBeenCalledWith(reference, expect.anything());
    expect(entry.provider.chargeMandate).toHaveBeenCalledTimes(1);

    // Double sweep: nothing left pending; outstanding NOT reduced again.
    const sweep2 = await reconcilePendingMandateCharges(db, {}, LATER);
    expect(sweep2.checked).toBe(0);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(1);
  });

  it("concurrent sweeps of the same pending row settle exactly once", async () => {
    const { db, store } = seedWithMandate();
    const charge = seedMandateCharge({ accountId: "acct-1", reference: "cr-acct-1-20250310-424242", amountCents: 4_000 });
    store.mandateCharges.push(charge);
    const entry = providerWith(async () => { throw new Error("unused"); }, async () => ({ status: "success" as const, amountCents: 4_000 }));
    __setMandateProvidersForTests(async () => [entry] as any);
    const [s1, s2] = await Promise.all([
      reconcilePendingMandateCharges(db, {}, LATER),
      reconcilePendingMandateCharges(db, {}, LATER),
    ]);
    // Exactly-once is a MONEY invariant: one repayment row, one decrement.
    // (Both sweepers may report 'settled' — the loser observed the winner's
    // already-settled no-op, which is correct idempotent behavior.)
    expect(store.accounts[0].outstandingCents).toBe(6_000);
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(1);
    expect(store.mandateCharges[0].status).toBe("success");
  });

  it("pending → failed releases the exactly-once claim, notifies, never settles", async () => {
    const { db, store } = seedWithMandate();
    const entry = providerWith(
      async (ctx: any) => ({ ok: true, reference: ctx.reference, status: "pending" as const, provider: "paystack" }),
      async () => ({ status: "failed" as const, amountCents: 0 }),
    );
    __setMandateProvidersForTests(async () => [entry] as any);
    const notice = vi.fn(async () => {});
    __setDunningNoticeForTests(notice);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    const reference = (res as any).reference as string;

    const sweep = await reconcilePendingMandateCharges(db, {}, LATER);
    expect(sweep).toMatchObject({ checked: 1, settled: 0, failed: 1 });
    expect(store.accounts[0].outstandingCents).toBe(10_000); // untouched
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(0);
    expect(store.mandateCharges[0].status).toBe("failed");
    // Claim released → the payment-link fallback can re-claim the reference.
    expect(store.webhookEvents).toHaveLength(0);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ reference, amountCents: 4_000 }));
  });

  it("provider still-pending / unknown (timeout) leaves the row for the next sweep", async () => {
    const { db, store } = seedWithMandate();
    const charge = seedMandateCharge({ accountId: "acct-1", amountCents: 4_000 });
    store.mandateCharges.push(charge);
    const entry = providerWith(async () => { throw new Error("unused"); }, async () => ({ status: "pending" as const, amountCents: 4_000 }));
    __setMandateProvidersForTests(async () => [entry] as any);
    const sweep = await reconcilePendingMandateCharges(db, {}, LATER);
    expect(sweep).toMatchObject({ checked: 1, settled: 0, failed: 0, stillPending: 1 });
    expect(store.mandateCharges[0].status).toBe("pending");
    expect(store.accounts[0].outstandingCents).toBe(10_000);
    expect(entry.provider.chargeMandate).not.toHaveBeenCalled(); // NEVER a re-charge
  });

  it("timeout-after-send: charge throws TimeoutError but provider confirms success — resolved via fetchStatus, no double collection", async () => {
    const { db, store } = seedWithMandate();
    let fetchStatusSees: "success" = "success";
    const entry = providerWith(
      async () => { throw new Error("TimeoutError: The operation was aborted"); },
      async () => ({ status: fetchStatusSees, amountCents: 4_000 }),
    );
    __setMandateProvidersForTests(async () => [entry] as any);
    const notice = vi.fn(async () => {});
    __setDunningNoticeForTests(notice);

    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    // Unknown outcome probed → success provider-side ⇒ kept pending for
    // exactly-once settlement; NO dunning, NO claim release, NO re-charge.
    expect(res).toMatchObject({ ok: true, status: "pending", outstandingAfter: 10_000 });
    expect(store.webhookEvents.filter((e: any) => e.type === "credit_repayment")).toHaveLength(1); // claim kept
    expect(store.webhookEvents.filter((e: any) => e.type === "credit_repayment_pending")).toHaveLength(1); // W30 marker kept while pending
    expect(store.webhookEvents.filter((e: any) => e.type === "credit_repayment")).toHaveLength(1); // claim kept
    expect(store.webhookEvents.filter((e: any) => e.type === "credit_repayment_pending")).toHaveLength(1); // W30 marker kept while pending
    expect(entry.provider.chargeMandate).toHaveBeenCalledTimes(1);
    expect(store.mandateCharges[0].status).toBe("pending");

    // Reconciler settles exactly once from the persisted pending row.
    const sweep = await reconcilePendingMandateCharges(db, {}, LATER);
    expect(sweep.settled).toBe(1);
    expect(store.accounts[0].outstandingCents).toBe(6_000);
    expect(store.ledger.filter((l) => l.kind === "repayment")).toHaveLength(1);
    expect(entry.provider.chargeMandate).toHaveBeenCalledTimes(1);
  });

  it("timeout-after-send with provider-confirmed FAILURE falls back (claim released, dunning sent)", async () => {
    const { db, store } = seedWithMandate();
    const entry = providerWith(
      async () => { throw new Error("TimeoutError"); },
      async () => ({ status: "failed" as const, amountCents: 0 }),
    );
    __setMandateProvidersForTests(async () => [entry] as any);
    const notice = vi.fn(async () => {});
    __setDunningNoticeForTests(notice);
    const res = await applyMandateRepaymentTx(db, { accountId: "acct-1", amountCents: 4_000 }, NOW);
    expect(res).toMatchObject({ ok: false, reason: "charge_failed" });
    expect(store.webhookEvents).toHaveLength(0); // released
    expect(store.accounts[0].outstandingCents).toBe(10_000);
    expect(notice).toHaveBeenCalled();
    expect(store.mandateCharges[0]?.status).toBe("failed");
  });
});
