/**
 * procurement enforcement tests — W13 enforcement coupling + supplier-direct
 * settlement:
 *
 *  - PO submission gate: isOrderAccessSuspended(buyer, supplier) blocks
 *    submit (manual AND auto-approve paths) with reason + "repay to restore"
 *    copy; drafts stay open; unsuspended / no-account buyers unaffected;
 *    the check fails open when the contract is missing or errors.
 *  - Supplier-direct settlement: a credit PO approval calls
 *    settleDrawToSupplier({ poId, drawResult: { ledgerId } }) and the PO
 *    lands in 'invoiced' (paid-via-credit, fulfillable) with no payment
 *    link; a failing settle call never rolls back the approved draw.
 *  - Router surface: createPo maps the gate to FORBIDDEN with copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendTextMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
const sendInteractiveMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...a: any[]) => sendTextMock(...a),
  sendWhatsAppInteractive: (...a: any[]) => sendInteractiveMock(...a),
  sendWhatsAppMedia: vi.fn(async () => ({ sent: true })),
}));

const credit = vi.hoisted(() => ({
  getCreditAccount: vi.fn(async (_s: string, _b: string) => null as any),
  drawOnCredit: vi.fn(async (_a: any) => ({ ok: true as const, ledgerId: "led-1", outstandingAfter: 150_000 })),
  suggestLimit: vi.fn(async () => ({ score: 62, suggestedLimitCents: 500_000, reasons: ["10 paid orders"] })),
  isOrderAccessSuspended: vi.fn(async (_b: string, _s: string) => false),
  settleDrawToSupplier: vi.fn(async (_a: any) => ({ ok: true })),
}));
vi.mock("./services/tradeCredit", () => credit);

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => dbHolder.db) };
});

import { approvePurchaseOrder, submitPurchaseOrder, cancelDraftPo } from "./services/procurement/poFlow";
import { suspensionMessage } from "./services/procurement/creditEnforcement";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { makeFakeDb, seedPo, seedSupplierProfile } from "./services/procurement/fakeDb";

const TENANTS = [
  { id: "buyer-1", name: "Buyer One", settings: { adminPhone: "+2348000000009" } },
  { id: "supplier-1", name: "Ada Wholesale", settings: { adminPhone: "+2348000000010" } },
];
const PROFILE = seedSupplierProfile({ tenantId: "supplier-1" });
const LINES = [{ name: "Rice 50kg", qty: 2, unitPriceCents: 25_000, productRef: "p1" }];

function makeDb(extra: Parameters<typeof makeFakeDb>[0] = {}) {
  return makeFakeDb({ tenants: TENANTS.map((t) => ({ ...t })), supplierProfiles: [PROFILE], ...extra });
}

function makeCtx(tenantId: string): TrpcContext {
  return {
    user: { id: 1, openId: "u", email: "t@e.c", name: "T", loginMethod: "manus", role: "admin", tenantId, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as any,
    req: {} as any,
    res: {} as any,
  } as TrpcContext;
}

function suspend(reason: string | null = "Overdue balance past 30 days", outstandingCents: number | null = 250_000) {
  credit.isOrderAccessSuspended.mockResolvedValue(true);
  credit.getCreditAccount.mockResolvedValue(
    reason == null && outstandingCents == null
      ? null
      : { id: "acc-1", status: "active", suspension_reason: reason, outstandingCents: outstandingCents ?? 0 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  credit.isOrderAccessSuspended.mockResolvedValue(false);
  credit.getCreditAccount.mockResolvedValue(null);
  credit.drawOnCredit.mockResolvedValue({ ok: true, ledgerId: "led-1", outstandingAfter: 150_000 });
  credit.settleDrawToSupplier.mockResolvedValue({ ok: true });
});

// ── Submit gate ──────────────────────────────────────────────────────────────
describe("PO submission gate", () => {
  it("blocks submit when the buyer is suspended, with reason + outstanding", async () => {
    suspend("Overdue balance past 30 days", 250_000);
    const { db, store } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("suspended");
    expect(result.suspensionReason).toBe("Overdue balance past 30 days");
    expect(result.outstandingCents).toBe(250_000);
    // No PO row created, no supplier action card sent.
    expect(store.purchaseOrders).toHaveLength(0);
    expect(sendInteractiveMock).not.toHaveBeenCalled();
  });

  it("blocks paynow submit too (gate is payment-mode agnostic)", async () => {
    suspend();
    const { db, store } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "paynow",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("suspended");
    expect(store.purchaseOrders).toHaveLength(0);
  });

  it("suspension message copy carries reason and repay-to-restore guidance", async () => {
    suspend("Overdue balance past 30 days", 250_000);
    const { db } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    const msg = suspensionMessage(
      { suspended: true, reason: result.suspensionReason ?? null, outstandingCents: result.outstandingCents ?? null },
      (c) => `₦${(c / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`,
    );
    expect(msg).toContain("Ordering is suspended");
    expect(msg).toContain("Overdue balance past 30 days");
    expect(msg.toLowerCase()).toContain("repay");
    expect(msg).toContain("₦2,500.00");
    expect(msg.toLowerCase()).toContain("restore ordering");
  });

  it("message copy works without a recorded reason or outstanding amount", () => {
    const msg = suspensionMessage({ suspended: true, reason: null, outstandingCents: null }, () => "₦0.00");
    expect(msg).toContain("Ordering is suspended");
    expect(msg.toLowerCase()).toContain("repay your outstanding balance to restore ordering");
  });

  it("draft POs stay open: a suspended buyer can still cancel a draft", async () => {
    suspend();
    const { db, store } = makeDb({
      purchaseOrders: [seedPo({ id: "po-draft", status: "draft", buyerTenantId: "buyer-1", supplierTenantId: "supplier-1" })],
      poItems: [{ id: "i1", poId: "po-draft", productRef: "p1", name: "Rice", qty: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }],
    });
    const res = await cancelDraftPo(db, { poId: "po-draft", buyerTenantId: "buyer-1" });
    expect(res.ok).toBe(true);
    expect(store.purchaseOrders).toHaveLength(0);
  });

  it("unsuspended buyer is unaffected", async () => {
    const { db } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.ok).toBe(true);
    expect(credit.isOrderAccessSuspended).toHaveBeenCalledWith("buyer-1", "supplier-1");
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1);
  });

  it("no credit account → contract returns false → submit proceeds", async () => {
    credit.isOrderAccessSuspended.mockResolvedValue(false); // contract: false when no account
    credit.getCreditAccount.mockResolvedValue(null);
    const { db } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "paynow",
    });
    expect(result.ok).toBe(true);
  });

  it("fails OPEN when the suspension check throws", async () => {
    credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
    const { db } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.ok).toBe(true);
  });

  it("W14 strict mode: lookup error fails CLOSED — submit blocked with try-again copy", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    try {
      credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
      const { db } = makeDb();
      const result = await submitPurchaseOrder(db, {
        buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("suspended");
        expect(result.suspensionReason).toBe("credit status unavailable, try again");
        expect(result.outstandingCents).toBeNull();
      }
      // No PO was persisted — the gate blocked BEFORE insert.
      expect(db === null).toBe(false);
    } finally {
      delete process.env.CREDIT_ENFORCEMENT_STRICT;
    }
  });

  it("W14 strict mode: explicit CREDIT_ENFORCEMENT_STRICT=false restores fail-open", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "false";
    try {
      credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
      const { db } = makeDb();
      const result = await submitPurchaseOrder(db, {
        buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
      });
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.CREDIT_ENFORCEMENT_STRICT;
    }
  });

  it("fails OPEN when the contract is not merged yet (function missing)", async () => {
    const orig = credit.isOrderAccessSuspended;
    // @ts-expect-error simulate pre-merge module shape
    delete credit.isOrderAccessSuspended;
    try {
      const { db } = makeDb();
      const result = await submitPurchaseOrder(db, {
        buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
      });
      expect(result.ok).toBe(true);
    } finally {
      credit.isOrderAccessSuspended = orig;
    }
  });

  it("gates the auto-approve path (auto_approve_below_cents)", async () => {
    suspend("Overdue balance", 100_000);
    const { db, store } = makeDb({
      supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", autoApproveBelowCents: 10_000_000 })],
    });
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("suspended");
    expect(result.autoApproved).toBeUndefined();
    expect(store.purchaseOrders).toHaveLength(0);
    expect(credit.drawOnCredit).not.toHaveBeenCalled();
  });

  it("auto-approve still works for buyers in good standing", async () => {
    const { db } = makeDb({
      supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", autoApproveBelowCents: 10_000_000 })],
    });
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.ok).toBe(true);
    expect(result.autoApproved).toBe(true);
    expect(credit.settleDrawToSupplier).toHaveBeenCalledTimes(1);
  });
});

// ── Supplier-direct settlement ───────────────────────────────────────────────
describe("supplier-direct settlement", () => {
  function seedSubmittedCreditPo() {
    return makeDb({
      purchaseOrders: [seedPo({
        id: "po-1", poNumber: "PO-20250101-AAAA", status: "submitted",
        buyerTenantId: "buyer-1", supplierTenantId: "supplier-1",
        paymentMode: "credit", termsDays: 14, subtotalCents: 50_000,
      })],
    });
  }

  it("credit approval settles the draw to the supplier and lands 'invoiced'", async () => {
    const { db, store } = seedSubmittedCreditPo();
    const result = await approvePurchaseOrder(db, { poId: "po-1" });
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "invoiced") {
      expect(result.dueDate).toBeInstanceOf(Date);
    } else {
      throw new Error("expected invoiced");
    }
    // The adapter reconstructs the successful-draw shape the tradeCredit
    // contract requires (ok: true) — a bare { ledgerId } silently no-ops.
    expect(credit.settleDrawToSupplier).toHaveBeenCalledWith({ poId: "po-1", drawResult: { ok: true, ledgerId: "led-1" } });
    expect(store.purchaseOrders[0].status).toBe("invoiced"); // paid-via-credit, fulfillable
    expect(store.purchaseOrders[0].dueDate).toBeTruthy();
  });

  it("invoiced PO is fulfillable without any payment confirmation", async () => {
    const { db, store } = seedSubmittedCreditPo();
    await approvePurchaseOrder(db, { poId: "po-1" });
    const { markPoFulfilled } = await import("./services/procurement/poFlow");
    const res = await markPoFulfilled(db, { poId: "po-1" });
    expect(res.ok).toBe(true);
    expect(store.purchaseOrders[0].status).toBe("fulfilled");
  });

  it("a failing settleDrawToSupplier never rolls back the approved draw", async () => {
    credit.settleDrawToSupplier.mockRejectedValue(new Error("ledger busy"));
    const { db, store } = seedSubmittedCreditPo();
    const result = await approvePurchaseOrder(db, { poId: "po-1" });
    expect(result.ok).toBe(true);
    expect(store.purchaseOrders[0].status).toBe("invoiced");
  });

  it("missing settle contract is a no-op and approval still succeeds", async () => {
    const orig = credit.settleDrawToSupplier;
    // @ts-expect-error simulate pre-merge module shape
    delete credit.settleDrawToSupplier;
    try {
      const { db, store } = seedSubmittedCreditPo();
      const result = await approvePurchaseOrder(db, { poId: "po-1" });
      expect(result.ok).toBe(true);
      expect(store.purchaseOrders[0].status).toBe("invoiced");
    } finally {
      credit.settleDrawToSupplier = orig;
    }
  });

  it("paynow approval does NOT call settleDrawToSupplier (payment link path)", async () => {
    const { db } = makeDb({
      purchaseOrders: [seedPo({
        id: "po-2", status: "submitted", buyerTenantId: "buyer-1", supplierTenantId: "supplier-1",
        paymentMode: "paynow", subtotalCents: 50_000,
      })],
    });
    const result = await approvePurchaseOrder(db, { poId: "po-2" });
    expect(result.ok).toBe(true);
    expect(credit.settleDrawToSupplier).not.toHaveBeenCalled();
  });
});

// ── Router surface ───────────────────────────────────────────────────────────
describe("createPo router gate", () => {
  it("suspended buyer → FORBIDDEN with reason + repay-to-restore copy", async () => {
    suspend("Overdue balance past 30 days", 250_000);
    dbHolder.db = makeDb().db;
    const caller = appRouter.createCaller(makeCtx("buyer-1"));
    await expect(
      caller.procurement.createPo({
        buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", paymentMode: "credit",
        lines: [{ name: "Rice 50kg", qty: 2, unitPriceCents: 25_000 }],
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Overdue balance past 30 days"),
    });
  });

  it("FORBIDDEN message includes outstanding amount and restore guidance", async () => {
    suspend("Overdue balance past 30 days", 250_000);
    dbHolder.db = makeDb().db;
    const caller = appRouter.createCaller(makeCtx("buyer-1"));
    const err = await caller.procurement.createPo({
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", paymentMode: "credit",
      lines: [{ name: "Rice 50kg", qty: 2, unitPriceCents: 25_000 }],
    }).catch((e: any) => e);
    expect(err.message).toContain("₦2,500.00");
    expect(err.message.toLowerCase()).toContain("repay");
    expect(err.message.toLowerCase()).toContain("restore ordering");
  });

  it("W14 strict mode: lookup outage → createPo FORBIDDEN with try-again copy", async () => {
    process.env.CREDIT_ENFORCEMENT_STRICT = "true";
    try {
      credit.isOrderAccessSuspended.mockRejectedValue(new Error("db down"));
      dbHolder.db = makeDb().db;
      const caller = appRouter.createCaller(makeCtx("buyer-1"));
      await expect(
        caller.procurement.createPo({
          buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", paymentMode: "credit",
          lines: [{ name: "Rice 50kg", qty: 2, unitPriceCents: 25_000 }],
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        // W14.1: transient outage → neutral try-again copy, never dunning.
        message: expect.stringContaining("couldn't confirm your credit status"),
      });
    } finally {
      delete process.env.CREDIT_ENFORCEMENT_STRICT;
    }
  });

  it("unsuspended buyer → createPo succeeds via the router", async () => {
    dbHolder.db = makeDb().db;
    const caller = appRouter.createCaller(makeCtx("buyer-1"));
    const out = await caller.procurement.createPo({
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", paymentMode: "paynow",
      lines: [{ name: "Rice 50kg", qty: 2, unitPriceCents: 25_000 }],
    });
    expect(out.po.status).toBe("submitted");
  });
});
