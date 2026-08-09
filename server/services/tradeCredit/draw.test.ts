/**
 * drawOnCredit — money-path invariant tests.
 *
 * The fake db honors the conditional-update semantics of the real claim-first
 * UPDATE (UPDATE ... WHERE status='active' AND outstanding + amt <= limit
 * RETURNING matches zero rows when the guard fails), so the overdraw race and
 * refusal paths are provably exercised.
 */
import { describe, it, expect } from "vitest";
import { drawOnCreditTx } from "./draw";
import { makeFakeDb, seedAccount } from "./fakeDb";

describe("drawOnCreditTx", () => {
  it("happy path: claims outstanding, writes invoice_draw with due_date = now + termsDays", async () => {
    const account = seedAccount({ limitCents: 100_000, termsDays: 30 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const now = new Date("2025-06-01T00:00:00Z");
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      amountCents: 40_000, poId: "po-1",
    }, now);
    expect(res).toEqual({ ok: true, ledgerId: expect.any(String), outstandingAfter: 40_000 });
    expect(store.accounts[0].outstandingCents).toBe(40_000);
    const entry = store.ledger[0];
    expect(entry.kind).toBe("invoice_draw");
    expect(entry.amountCents).toBe(40_000);
    expect(entry.poId).toBe("po-1");
    expect(entry.status).toBe("posted");
    expect(entry.dueDate?.toISOString()).toBe(new Date(now.getTime() + 30 * 864e5).toISOString());
  });

  it("explicit termsDays overrides the account default for due_date", async () => {
    const account = seedAccount({ termsDays: 30 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const now = new Date("2025-06-01T00:00:00Z");
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      amountCents: 5_000, poId: "po-2", termsDays: 7,
    }, now);
    expect(res.ok).toBe(true);
    expect(store.ledger[0].dueDate?.toISOString()).toBe(new Date(now.getTime() + 7 * 864e5).toISOString());
  });

  it("draw exactly at the limit succeeds (guard is <=)", async () => {
    const account = seedAccount({ limitCents: 50_000, outstandingCents: 20_000 });
    const { db } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      amountCents: 30_000, poId: "po-edge",
    });
    expect(res).toMatchObject({ ok: true, outstandingAfter: 50_000 });
  });

  it("over-limit draw is refused with reason 'over_limit' and writes nothing", async () => {
    const account = seedAccount({ limitCents: 50_000, outstandingCents: 20_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      amountCents: 30_001, poId: "po-over",
    });
    expect(res).toEqual({ ok: false, reason: "over_limit" });
    expect(store.accounts[0].outstandingCents).toBe(20_000);
    expect(store.ledger).toHaveLength(0);
  });

  it("frozen account refuses with reason 'frozen'", async () => {
    const account = seedAccount({ status: "frozen" });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      amountCents: 1_000, poId: "po-frozen",
    });
    expect(res).toEqual({ ok: false, reason: "frozen" });
    expect(store.ledger).toHaveLength(0);
  });

  it("closed account refuses with reason 'closed'", async () => {
    const account = seedAccount({ status: "closed" });
    const { db } = makeFakeDb({ accounts: [account] });
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      amountCents: 1_000, poId: "po-closed",
    });
    expect(res).toEqual({ ok: false, reason: "closed" });
  });

  it("missing account refuses with reason 'no_account'", async () => {
    const { db } = makeFakeDb();
    const res = await drawOnCreditTx(db, {
      supplierTenantId: "supplier-x", buyerTenantId: "buyer-x",
      amountCents: 1_000, poId: "po-none",
    });
    expect(res).toEqual({ ok: false, reason: "no_account" });
  });

  it("non-positive amounts are refused without touching state", async () => {
    const account = seedAccount();
    const { db, store } = makeFakeDb({ accounts: [account] });
    for (const amountCents of [0, -500]) {
      const res = await drawOnCreditTx(db, {
        supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents, poId: "po-neg",
      });
      expect(res.ok).toBe(false);
    }
    expect(store.accounts[0].outstandingCents).toBe(0);
    expect(store.ledger).toHaveLength(0);
  });

  it("OVERDRAW RACE: 10 concurrent draws against the limit — total drawn never exceeds it", async () => {
    // Limit 100_000, ten concurrent 25_000 draws ⇒ at most 4 can land.
    const account = seedAccount({ limitCents: 100_000 });
    const { db, store } = makeFakeDb({ accounts: [account] });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        drawOnCreditTx(db, {
          supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
          amountCents: 25_000, poId: `po-race-${i}`,
        })),
    );
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(4);
    expect(results.filter((r) => !r.ok && r.reason === "over_limit")).toHaveLength(6);
    expect(store.accounts[0].outstandingCents).toBe(100_000);
    expect(store.accounts[0].outstandingCents).toBeLessThanOrEqual(100_000);
    expect(store.ledger).toHaveLength(4);
    // Every successful draw reported the post-claim outstanding.
    const reported = succeeded.map((r) => (r as any).outstandingAfter).sort((a, b) => a - b);
    expect(reported).toEqual([25_000, 50_000, 75_000, 100_000]);
  });

  it("concurrent draws on different accounts do not interfere", async () => {
    const a = seedAccount({ id: "acc-a", buyerTenantId: "buyer-a", limitCents: 10_000 });
    const b = seedAccount({ id: "acc-b", buyerTenantId: "buyer-b", limitCents: 10_000 });
    const { db, store } = makeFakeDb({ accounts: [a, b] });
    const [ra, rb] = await Promise.all([
      drawOnCreditTx(db, { supplierTenantId: "supplier-1", buyerTenantId: "buyer-a", amountCents: 10_000, poId: "po-a" }),
      drawOnCreditTx(db, { supplierTenantId: "supplier-1", buyerTenantId: "buyer-b", amountCents: 10_000, poId: "po-b" }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(store.accounts.map((r) => r.outstandingCents)).toEqual([10_000, 10_000]);
  });
});
