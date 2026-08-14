/**
 * Dunning sweep — reminder idempotency, once-per-draw late fee, +7d freeze,
 * fail-safe sends.
 *
 * waSender and sessionWindow are mocked: sends are counted, the session
 * window is controlled per test, and send failures are simulated to prove
 * the sweep never throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendText = vi.fn(async () => ({ sent: true, simulated: true, wamid: null, chunks: 1 }));
const sendTemplate = vi.fn(async () => ({ sent: true, simulated: true, wamid: null }));
const getWindowMock = vi.fn(async () => ({ open: false, closesAt: null, lastInboundAt: null, source: "none" as const }));

vi.mock("../waSender", () => ({
  sendWhatsAppText: (...args: unknown[]) => sendText(...args),
  sendWhatsAppTemplate: (...args: unknown[]) => sendTemplate(...args),
}));
vi.mock("../sessionWindow", () => ({
  getWindow: (...args: unknown[]) => getWindowMock(...args),
}));

import { runDunningCheckTx, LATE_FEE_RATE } from "./dunning";
import { makeFakeDb, seedAccount, seedDraw, type TenantRow } from "./fakeDb";

const NOW = new Date("2025-06-10T00:00:00Z");
const dueOn = (d: string) => new Date(`${d}T00:00:00Z`);
const buyerTenant: TenantRow = { id: "buyer-1", settings: { adminPhone: "2348011111111" } };

beforeEach(() => {
  sendText.mockClear();
  sendTemplate.mockClear();
  getWindowMock.mockClear();
  getWindowMock.mockResolvedValue({ open: false, closesAt: null, lastInboundAt: null, source: "none" });
});

function seed(over: { account?: Partial<ReturnType<typeof seedAccount>>; draw?: Partial<ReturnType<typeof seedDraw>> } = {}) {
  const account = seedAccount(over.account);
  const draw = seedDraw(account.id, over.draw);
  return makeFakeDb({ accounts: [account], ledger: [draw], tenants: [buyerTenant] });
}

describe("runDunningCheckTx", () => {
  it("no draws due within the horizon → all zeros, no sends", async () => {
    const { db } = seed({ draw: { dueDate: dueOn("2025-07-01") } }); // 21d out
    const res = await runDunningCheckTx(db, NOW);
    expect(res).toEqual({ reminded: 0, feesApplied: 0, frozen: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("-3d window: upcoming draw reminds once; repeat sweep stays quiet (idempotent)", async () => {
    const { db, store } = seed({ draw: { dueDate: dueOn("2025-06-12") } }); // offset -2
    const first = await runDunningCheckTx(db, NOW);
    expect(first).toEqual({ reminded: 1, feesApplied: 0, frozen: 0 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(store.ledger[0].note).toContain("[dun:r-3]");
    const second = await runDunningCheckTx(db, NOW);
    expect(second).toEqual({ reminded: 0, feesApplied: 0, frozen: 0 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("due-then-overdue progression fires r0 and later r+3 milestones", async () => {
    const { db, store } = seed({ draw: { dueDate: dueOn("2025-06-10") } }); // offset 0
    expect((await runDunningCheckTx(db, NOW)).reminded).toBe(1);
    expect(store.ledger[0].note).toContain("[dun:r0]");
    // +3d later
    const later = new Date(NOW.getTime() + 3 * 864e5);
    const res = await runDunningCheckTx(db, later);
    expect(res.reminded).toBe(1);
    expect(store.ledger[0].note).toContain("[dun:r+3]");
    expect(sendTemplate).toHaveBeenCalledTimes(2);
  });

  it("+3d overdue: late fee of 2% applied once per draw, even across sweeps", async () => {
    const { db, store } = seed({ draw: { dueDate: dueOn("2025-06-07"), amountCents: 50_000 } }); // offset +3
    const first = await runDunningCheckTx(db, NOW);
    expect(first.feesApplied).toBe(1);
    const fee = store.ledger.find((l) => l.kind === "fee");
    expect(fee).toBeDefined();
    expect(fee!.amountCents).toBe(Math.round(50_000 * LATE_FEE_RATE)); // 1000
    expect(fee!.ref).toBe(`latefee:${store.ledger[0].id}`);
    const second = await runDunningCheckTx(db, NOW);
    expect(second.feesApplied).toBe(0);
    expect(store.ledger.filter((l) => l.kind === "fee")).toHaveLength(1);
  });

  it("A1-08(b): the late fee INCREASES outstanding (collectible debt), exactly once", async () => {
    const { db, store } = seed({
      account: { outstandingCents: 50_000 },
      draw: { dueDate: dueOn("2025-06-07"), amountCents: 50_000 }, // offset +3
    });
    const first = await runDunningCheckTx(db, NOW);
    expect(first.feesApplied).toBe(1);
    // Fee = 2% of 50_000 = 1_000 — outstanding grows by the fee, making the
    // fee collectible through the normal repayment path.
    expect(store.accounts[0].outstandingCents).toBe(51_000);
    // Idempotent across sweeps: no second increment.
    await runDunningCheckTx(db, NOW);
    expect(store.accounts[0].outstandingCents).toBe(51_000);
    expect(store.ledger.filter((l) => l.kind === "fee")).toHaveLength(1);
  });

  it("A1-08(b): a fee-bearing outstanding is repaid through applyRepaymentTx", async () => {
    const { db, store } = seed({
      account: { outstandingCents: 50_000 },
      draw: { dueDate: dueOn("2025-06-07"), amountCents: 50_000 },
    });
    await runDunningCheckTx(db, NOW);
    expect(store.accounts[0].outstandingCents).toBe(51_000);
    const { applyRepaymentTx } = await import("./repayment");
    const rep = await applyRepaymentTx(db, { accountId: store.accounts[0].id, amountCents: 51_000, ref: "r-fee-1" }, NOW);
    expect(rep.ok).toBe(true);
    expect(store.accounts[0].outstandingCents).toBe(0);
    // The draw row settles FIFO; the fee was collected as outstanding.
    expect(store.ledger.find((l) => l.kind === "invoice_draw")?.status).toBe("settled");
  });

  it("+7d overdue: freezes the account (claim-first), reports frozen once", async () => {
    const { db, store } = seed({ draw: { dueDate: dueOn("2025-06-03") } }); // offset +7
    const first = await runDunningCheckTx(db, NOW);
    expect(first.frozen).toBe(1);
    expect(store.accounts[0].status).toBe("frozen");
    const second = await runDunningCheckTx(db, NOW);
    expect(second.frozen).toBe(0); // already frozen — no double count
  });

  it("settled draws are never dunned", async () => {
    const { db } = seed({ draw: { dueDate: dueOn("2025-06-01"), status: "settled" } });
    const res = await runDunningCheckTx(db, NOW);
    expect(res).toEqual({ reminded: 0, feesApplied: 0, frozen: 0 });
  });

  it("closed accounts are skipped entirely", async () => {
    const { db, store } = seed({
      account: { status: "closed" },
      draw: { dueDate: dueOn("2025-06-01") },
    });
    const res = await runDunningCheckTx(db, NOW);
    expect(res).toEqual({ reminded: 0, feesApplied: 0, frozen: 0 });
    expect(store.ledger.filter((l) => l.kind === "fee")).toHaveLength(0);
  });

  it("session window open → free-form text; closed → template", async () => {
    getWindowMock.mockResolvedValueOnce({ open: true, closesAt: new Date(NOW.getTime() + 3600e3), lastInboundAt: NOW, source: "redis" });
    const a = seed({ draw: { dueDate: dueOn("2025-06-10") } });
    await runDunningCheckTx(a.db, NOW);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendTemplate).not.toHaveBeenCalled();
    sendText.mockClear();
    getWindowMock.mockResolvedValueOnce({ open: false, closesAt: null, lastInboundAt: null, source: "none" });
    const b = seed({ draw: { dueDate: dueOn("2025-06-10") } });
    await runDunningCheckTx(b.db, NOW);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    // template is addressed to the BUYER tenant's admin phone
    expect(sendTemplate.mock.calls[0][0]).toBe("buyer-1");
    expect(sendTemplate.mock.calls[0][1]).toBe("2348011111111");
  });

  it("fail-safe: a throwing send never breaks the sweep; freeze still applies", async () => {
    sendTemplate.mockRejectedValueOnce(new Error("network down"));
    const { db, store } = seed({ draw: { dueDate: dueOn("2025-06-03") } }); // +7d
    const res = await runDunningCheckTx(db, NOW);
    expect(res.frozen).toBe(1);
    expect(store.accounts[0].status).toBe("frozen");
    expect(res.reminded).toBe(0); // failed send is not counted
  });

  it("fail-safe: a scan-level db failure returns zeros instead of throwing", async () => {
    const brokenDb = {
      select() { throw new Error("db gone"); },
    };
    const res = await runDunningCheckTx(brokenDb as any, NOW);
    expect(res).toEqual({ reminded: 0, feesApplied: 0, frozen: 0 });
  });

  it("buyer without an admin phone: reminder skipped, sweep continues", async () => {
    const account = seedAccount();
    const draw = seedDraw(account.id, { dueDate: dueOn("2025-06-10") });
    const { db } = makeFakeDb({
      accounts: [account], ledger: [draw],
      tenants: [{ id: "buyer-1", settings: {} }],
    });
    const res = await runDunningCheckTx(db, NOW);
    expect(res.reminded).toBe(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("multiple overdue draws on one account freeze it exactly once", async () => {
    const account = seedAccount();
    const d1 = seedDraw(account.id, { id: "d1", dueDate: dueOn("2025-06-01") });
    const d2 = seedDraw(account.id, { id: "d2", dueDate: dueOn("2025-06-02") });
    const { db, store } = makeFakeDb({ accounts: [account], ledger: [d1, d2], tenants: [buyerTenant] });
    const res = await runDunningCheckTx(db, NOW);
    expect(res.frozen).toBe(1);
    expect(res.feesApplied).toBe(2); // both draws past +3d
    expect(store.accounts[0].status).toBe("frozen");
  });
});
