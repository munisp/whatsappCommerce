/**
 * A1-04 / F-01 regression: concurrent PO approval must NEVER double-draw.
 *
 * Pre-fix (audit-reproduced): approvePurchaseOrder gated on a plain read of
 * po.status, then drew, then updated the PO with WHERE id only — two
 * concurrent approvals both drew (2 invoice_draw rows, outstanding
 * incremented twice for one PO).
 *
 * Post-fix layers under test here (real tradeCredit engine against the
 * guard-faithful fakeDb, only waSender/redis/db mocked):
 *   (a) claim-first status transition (UPDATE ... WHERE status='submitted')
 *       — only one approval owns the transition;
 *   (b) credit_ledger_draw_ref_uniq (0053) — the DB backstop making the
 *       draw insert exactly-once per (account, ref=draw:{poId});
 *   (c) 23505 → idempotent already-drawn translation in drawOnCreditTx,
 *       so the loser/crash-retry returns success WITHOUT a second draw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./services/waSender", () => ({
  sendWhatsAppText: vi.fn(async () => ({ sent: true })),
  sendWhatsAppInteractive: vi.fn(async () => ({ sent: true })),
  sendWhatsAppMedia: vi.fn(async () => ({ sent: true })),
}));
vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => dbHolder.db) };
});

import { approvePurchaseOrder } from "./services/procurement/poFlow";
import { makeFakeDb as makePoDb, seedPo, seedSupplierProfile } from "./services/procurement/fakeDb";
import { makeFakeDb as makeCreditDb, seedAccount } from "./services/tradeCredit/fakeDb";

const TENANTS = [
  { id: "buyer-1", name: "Buyer One", settings: { adminPhone: "+2348000000009" } },
  { id: "supplier-1", name: "Ada Wholesale", settings: { adminPhone: "+2348000000010" } },
];

function setup(poStatus = "submitted") {
  const po = seedPo({
    id: "po-1", poNumber: "PO-20250101-AAAA", status: poStatus,
    buyerTenantId: "buyer-1", supplierTenantId: "supplier-1",
    paymentMode: "credit", termsDays: 14, subtotalCents: 50_000,
  });
  const poFake = makePoDb({
    tenants: TENANTS.map((t) => ({ ...t })),
    supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1" })],
    purchaseOrders: [po],
  });
  const creditFake = makeCreditDb({
    accounts: [seedAccount({
      id: "acct-1", supplierTenantId: "supplier-1", buyerTenantId: "buyer-1",
      limitCents: 1_000_000, outstandingCents: 0, status: "active",
      createdAt: new Date("2024-01-01T00:00:00Z"), // tenure gate satisfied
    })],
    // settleDrawToSupplierTx runs against the credit db handle.
    purchaseOrders: [{
      id: "po-1", poNumber: po.poNumber, buyerTenantId: "buyer-1", supplierTenantId: "supplier-1",
      status: "invoiced", subtotalCents: 50_000, paymentMode: "credit", creditAccountId: "acct-1",
      termsDays: 14, dueDate: null, buyerPhone: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    }],
  });
  dbHolder.db = creditFake.db;
  return { poDb: poFake.db, poStore: poFake.store, creditStore: creditFake.store };
}

beforeEach(() => vi.clearAllMocks());

describe("approvePurchaseOrder — double-draw race (A1-04/F-01)", () => {
  it("two concurrent approvals produce EXACTLY ONE invoice_draw and one outstanding increment", async () => {
    const { poDb, poStore, creditStore } = setup();
    const [r1, r2] = await Promise.all([
      approvePurchaseOrder(poDb, { poId: "po-1" }),
      approvePurchaseOrder(poDb, { poId: "po-1" }),
    ]);
    const draws = creditStore.ledger.filter((l) => l.kind === "invoice_draw");
    expect(draws).toHaveLength(1);
    expect(draws[0].ref).toBe("draw:po-1");
    expect(creditStore.accounts[0].outstandingCents).toBe(50_000);
    // Winner drew; loser either got the idempotent replay (already invoiced)
    // or wrong_status — but NEVER a second draw.
    expect(r1.ok || r2.ok).toBe(true);
    expect(poStore.purchaseOrders[0].status).toBe("invoiced");
  });

  it("10-way concurrent approval still yields exactly one draw", async () => {
    const { poDb, creditStore } = setup();
    await Promise.all(
      Array.from({ length: 10 }, () => approvePurchaseOrder(poDb, { poId: "po-1" })),
    );
    expect(creditStore.ledger.filter((l) => l.kind === "invoice_draw")).toHaveLength(1);
    expect(creditStore.accounts[0].outstandingCents).toBe(50_000);
  });

  it("crash-retry: PO claimed ('invoiced') but draw never ran → retry converges with one draw", async () => {
    // Simulated crash window: a previous approval claimed the status flip and
    // died before drawOnCredit. The PO is 'invoiced' with NO draw row.
    const { poDb, poStore, creditStore } = setup("invoiced");
    const res = await approvePurchaseOrder(poDb, { poId: "po-1" });
    expect(res.ok).toBe(true);
    expect(creditStore.ledger.filter((l) => l.kind === "invoice_draw")).toHaveLength(1);
    expect(creditStore.accounts[0].outstandingCents).toBe(50_000);
    expect(poStore.purchaseOrders[0].dueDate).toBeTruthy();
  });

  it("re-approving a fully completed PO is refused wrong_status — and never draws again", async () => {
    const { poDb, creditStore } = setup();
    const first = await approvePurchaseOrder(poDb, { poId: "po-1" });
    expect(first.ok).toBe(true);
    const second = await approvePurchaseOrder(poDb, { poId: "po-1" });
    expect(second).toMatchObject({ ok: false, reason: "wrong_status" });
    expect(creditStore.ledger.filter((l) => l.kind === "invoice_draw")).toHaveLength(1);
    expect(creditStore.accounts[0].outstandingCents).toBe(50_000);
  });

  it("draw refusal reverts the claim to 'submitted' so a later approval can retry", async () => {
    const { poDb, poStore, creditStore } = setup();
    creditStore.accounts[0].limitCents = 10_000; // over limit → draw refused
    const res = await approvePurchaseOrder(poDb, { poId: "po-1" });
    expect(res).toMatchObject({ ok: false, reason: "over_limit" });
    expect(poStore.purchaseOrders[0].status).toBe("submitted"); // claim reverted
    expect(creditStore.ledger.filter((l) => l.kind === "invoice_draw")).toHaveLength(0);
    // Retry after a limit raise succeeds — the revert really unblocked it.
    creditStore.accounts[0].limitCents = 1_000_000;
    const retry = await approvePurchaseOrder(poDb, { poId: "po-1" });
    expect(retry.ok).toBe(true);
    expect(creditStore.ledger.filter((l) => l.kind === "invoice_draw")).toHaveLength(1);
  });

  it("a rejected/fulfilled/paid PO is still refused wrong_status", async () => {
    const { poDb, creditStore } = setup("fulfilled");
    const res = await approvePurchaseOrder(poDb, { poId: "po-1" });
    expect(res).toMatchObject({ ok: false, reason: "wrong_status" });
    expect(creditStore.ledger).toHaveLength(0);
  });
});
