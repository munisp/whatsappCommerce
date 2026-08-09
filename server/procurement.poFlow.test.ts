/**
 * procurement poFlow tests — full PO lifecycle both payment modes, supplier
 * action cards, credit-path ok + over_limit fallback, paynow path, MOQ
 * enforcement, po_number format/uniqueness, and the WhatsApp chat state
 * machine (browse → add → review → terms → confirm).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
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
}));
vi.mock("./services/tradeCredit", () => credit);

const paymentInitiateMock = vi.hoisted(() => vi.fn(async () => ({ paymentUrl: "https://pay.example/abc", reference: "ref-1" })));
vi.mock("./routers", () => ({
  appRouter: { createCaller: () => ({ payment: { initiate: paymentInitiateMock } }) },
}));

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

import {
  approvePurchaseOrder,
  buildSupplierPoCard,
  cancelDraftPo,
  formatNaira,
  generatePoNumber,
  getPoById,
  handlePoAction,
  handlePoPaymentConfirmed,
  handleProcurementChat,
  markPoFulfilled,
  parsePoActionReplyId,
  poActionReplyId,
  rejectPurchaseOrder,
  submitPurchaseOrder,
} from "./services/procurement/poFlow";
import { makeFakeDb, seedPo, seedSupplierProfile } from "./services/procurement/fakeDb";
import { getSession, __clearMemorySessions } from "./services/chatSession";

const TENANTS = [
  { id: "buyer-1", name: "Buyer One", settings: { adminPhone: "+2348000000009" } },
  { id: "supplier-1", name: "Ada Wholesale", settings: { adminPhone: "+2348000000010" } },
];
const PROFILE = seedSupplierProfile({ tenantId: "supplier-1" });

function makeDb(extra: Parameters<typeof makeFakeDb>[0] = {}) {
  return makeFakeDb({ tenants: TENANTS.map((t) => ({ ...t })), supplierProfiles: [PROFILE], ...extra });
}

const LINES = [{ name: "Rice 50kg", qty: 2, unitPriceCents: 25_000, productRef: "p1" }];

beforeEach(() => {
  vi.clearAllMocks();
  __clearMemorySessions();
  credit.getCreditAccount.mockResolvedValue(null);
  credit.drawOnCredit.mockResolvedValue({ ok: true, ledgerId: "led-1", outstandingAfter: 150_000 });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe("po helpers", () => {
  it("formatNaira renders cents as ₦ major units", () => {
    expect(formatNaira(123_456)).toBe("₦1,234.56");
  });

  it("po action reply ids round-trip", () => {
    expect(poActionReplyId("approve", "po-1")).toBe("po_approve:po-1");
    expect(parsePoActionReplyId("po_reject:po-9")).toEqual({ action: "reject", poId: "po-9" });
    expect(parsePoActionReplyId("order_pay:x")).toBeNull();
  });

  it("supplier card carries PO number, buyer, amount and net terms", () => {
    const card = buildSupplierPoCard({ poId: "p1", poNumber: "PO-1", buyerName: "Buyer One", subtotalCents: 50_000, paymentMode: "credit", termsDays: 30 });
    expect(card.bodyText).toContain("PO-1");
    expect(card.bodyText).toContain("Buyer One");
    expect(card.bodyText).toContain("net 30d");
    if (card.action.type === "button") {
      expect(card.action.buttons.map((b) => b.id)).toEqual(["po_approve:p1", "po_reject:p1"]);
    } else {
      throw new Error("expected buttons");
    }
  });

  it("po_number format is PO-YYYYMMDD-XXXX and collides safely", async () => {
    const { db, store } = makeDb();
    const n = await generatePoNumber(db, new Date("2025-03-04T10:00:00Z"));
    expect(n).toMatch(/^PO-20250304-[A-Z2-9]{4}$/);
    // Seed a collision and force Math.random to repeat the same suffix once.
    store.purchaseOrders.push(seedPo({ poNumber: "PO-20250304-AAAA" }));
    const spy = vi.spyOn(Math, "random");
    try {
      for (let i = 0; i < 4; i++) spy.mockReturnValueOnce(0); // "AAAA" — taken
      spy.mockReturnValue(0.5); // "SSSS" — free
      const n2 = await generatePoNumber(db, new Date("2025-03-04T10:00:00Z"));
      expect(n2).toBe("PO-20250304-SSSS");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Submit + approve: credit mode ────────────────────────────────────────────
describe("credit PO lifecycle", () => {
  it("submit → supplier admin gets the Approve/Reject card", async () => {
    const { db, store } = makeDb();
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", buyerPhone: "+2348000000001",
      lines: LINES, paymentMode: "credit",
    });
    expect(result.ok).toBe(true);
    const po = store.purchaseOrders[0];
    expect(po.status).toBe("submitted");
    expect(po.paymentMode).toBe("credit");
    expect(po.termsDays).toBe(14); // supplier default
    expect(po.poNumber).toMatch(/^PO-\d{8}-[A-Z2-9]{4}$/);
    expect(store.poItems).toHaveLength(1);
    expect(store.poItems[0].lineTotalCents).toBe(50_000);
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1);
    const [tenantId, phone, card] = sendInteractiveMock.mock.calls[0];
    expect(tenantId).toBe("supplier-1");
    expect(phone).toBe("+2348000000010");
    expect(card.action.buttons[0].id).toBe(`po_approve:${po.id}`);
  });

  it("approve on credit → drawOnCredit ok → invoiced + due_date + buyer notified", async () => {
    const po = seedPo({ id: "po-1" });
    const { db, store } = makeDb({ purchaseOrders: [po] });
    credit.getCreditAccount.mockResolvedValue({ id: "acct-1", status: "active", termsDays: 30 } as any);
    const before = Date.now();
    const result = await approvePurchaseOrder(db, { poId: "po-1" });
    expect(result.ok).toBe(true);
    if (result.ok && result.status === "invoiced") {
      expect(result.outstandingAfter).toBe(150_000);
      const days = (result.dueDate.getTime() - before) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    } else {
      throw new Error("expected invoiced");
    }
    expect(credit.drawOnCredit).toHaveBeenCalledWith(expect.objectContaining({
      supplierTenantId: "supplier-1", buyerTenantId: "buyer-1", amountCents: 50_000, poId: "po-1",
    }));
    const updated = store.purchaseOrders[0];
    expect(updated.status).toBe("invoiced");
    expect(updated.creditAccountId).toBe("acct-1");
    expect(updated.dueDate).toBeTruthy();
  });

  it("handlePoAction approve (credit) notifies buyer with due date + outstanding", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    const out = await handlePoAction({ db, tenantId: "supplier-1", phone: "+2348000000010", action: "approve", poId: "po-1" });
    expect(out.reply).toContain("approved on credit");
    const buyerMsg = sendTextMock.mock.calls.find((c) => c[0] === "buyer-1");
    expect(buyerMsg?.[2]).toContain("due");
    expect(buyerMsg?.[2]).toContain("Outstanding");
  });

  it("over_limit draw → buyer offered pay-now / limit-increase fallback", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    credit.drawOnCredit.mockResolvedValue({ ok: false, reason: "over_limit" } as any);
    const out = await handlePoAction({ db, tenantId: "supplier-1", phone: "+2348000000010", action: "approve", poId: "po-1" });
    expect(out.reply).toContain("credit limit");
    const buyerMsg = sendTextMock.mock.calls.find((c) => c[0] === "buyer-1");
    expect(buyerMsg?.[2]).toContain("Pay now instead");
    expect(buyerMsg?.[2]).toContain("limit increase");
    const session = await getSession("buyer-1", "+2348000000001");
    expect(session?.step).toBe("po_credit_fallback");
  });

  it("no_account draw failure is reported to the supplier", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    credit.drawOnCredit.mockResolvedValue({ ok: false, reason: "no_account" } as any);
    const out = await handlePoAction({ db, tenantId: "supplier-1", phone: "+2348000000010", action: "approve", poId: "po-1" });
    expect(out.reply).toContain("no credit account");
  });

  it("auto-approve below threshold still runs the credit draw guard", async () => {
    const { db, store } = makeDb({
      supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", autoApproveBelowCents: 100_000 })],
    });
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.autoApproved).toBe(true);
    expect(credit.drawOnCredit).toHaveBeenCalledTimes(1);
    expect(store.purchaseOrders[0].status).toBe("invoiced");
    expect(sendInteractiveMock).not.toHaveBeenCalled(); // no manual card needed
  });

  it("auto-approve falls back to manual card when the draw guard fails", async () => {
    credit.drawOnCredit.mockResolvedValue({ ok: false, reason: "frozen" } as any);
    const { db, store } = makeDb({
      supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", autoApproveBelowCents: 100_000 })],
    });
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result.autoApproved).toBe(false);
    expect(store.purchaseOrders[0].status).toBe("submitted");
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1);
  });

  it("credit fallback: buyer picks pay-now → PO switched + supplier re-carded", async () => {
    const { db, store } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    const ctx = { db, tenantId: "buyer-1", phone: "+2348000000001" };
    const out = await handleProcurementChat(ctx, { step: "po_credit_fallback", data: { poId: "po-1" } }, "1");
    expect(out.reply).toContain("pay now");
    expect(store.purchaseOrders[0].paymentMode).toBe("paynow");
    expect(store.purchaseOrders[0].termsDays).toBeNull();
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1); // fresh supplier card
  });

  it("credit fallback: buyer requests limit increase → supplier notified with suggestion", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    const ctx = { db, tenantId: "buyer-1", phone: "+2348000000001" };
    const out = await handleProcurementChat(ctx, { step: "po_credit_fallback", data: { poId: "po-1" } }, "2");
    expect(out.reply).toContain("Request sent");
    expect(credit.suggestLimit).toHaveBeenCalledWith("buyer-1", "supplier-1");
    const supplierMsg = sendTextMock.mock.calls.find((c) => c[0] === "supplier-1");
    expect(supplierMsg?.[2]).toContain("limit increase");
  });
});

// ── Paynow mode ──────────────────────────────────────────────────────────────
describe("paynow PO lifecycle", () => {
  it("approve paynow → approved + payment link sent to buyer", async () => {
    const { db, store } = makeDb({ purchaseOrders: [seedPo({ id: "po-1", paymentMode: "paynow", termsDays: null })] });
    const result = await approvePurchaseOrder(db, { poId: "po-1" });
    expect(result).toEqual({ ok: true, status: "approved", paymentUrl: "https://pay.example/abc" });
    expect(store.purchaseOrders[0].status).toBe("approved");
    expect(paymentInitiateMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "supplier-1", orderId: "po-1", amount: 500, metadata: expect.objectContaining({ type: "po_payment", poId: "po-1" }),
    }));
    const buyerMsg = sendTextMock.mock.calls.find((c) => c[0] === "buyer-1");
    expect(buyerMsg?.[2]).toContain("https://pay.example/abc");
  });

  it("payment confirm → paid + both sides notified; replay is idempotent", async () => {
    const { db, store } = makeDb({ purchaseOrders: [seedPo({ id: "po-1", paymentMode: "paynow", status: "approved" })] });
    const first = await handlePoPaymentConfirmed(db, { poId: "po-1", reference: "ref-1" });
    expect(first).toEqual({ ok: true, action: "paid" });
    expect(store.purchaseOrders[0].status).toBe("paid");
    expect(sendTextMock.mock.calls.some((c) => c[0] === "buyer-1")).toBe(true);
    expect(sendTextMock.mock.calls.some((c) => c[0] === "supplier-1")).toBe(true);
    const replay = await handlePoPaymentConfirmed(db, { poId: "po-1", reference: "ref-1" });
    expect(replay.action).toBe("already_paid");
  });

  it("payment confirm on a submitted PO is rejected", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    const result = await handlePoPaymentConfirmed(db, { poId: "po-1" });
    expect(result.ok).toBe(false);
  });
});

// ── Reject / cancel / fulfill ────────────────────────────────────────────────
describe("reject, cancel, fulfill", () => {
  it("supplier reject via action card → rejected + reason prompt; reason forwarded to buyer", async () => {
    const { db, store } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    const out = await handlePoAction({ db, tenantId: "supplier-1", phone: "+2348000000010", action: "reject", poId: "po-1" });
    expect(out.reasonPrompt).toEqual({ poId: "po-1" });
    expect(store.purchaseOrders[0].status).toBe("rejected");
    // Reason follow-up via the chat state machine
    const ctx = { db, tenantId: "supplier-1", phone: "+2348000000010" };
    const r = await handleProcurementChat(ctx, { step: "po_reject_reason", data: { poId: "po-1" } }, "Out of stock until Friday");
    expect(r.nextState).toBeNull();
    const buyerMsg = sendTextMock.mock.calls.filter((c) => c[0] === "buyer-1").pop();
    expect(buyerMsg?.[2]).toContain("Out of stock until Friday");
  });

  it("buyer can cancel a DRAFT PO only; wrong owner/status are refused", async () => {
    const draft = seedPo({ id: "po-draft", status: "draft" });
    const { db, store } = makeDb({ purchaseOrders: [draft], poItems: [{ id: "i1", poId: "po-draft", productRef: "p1", name: "Rice", qty: 1, unitPriceCents: 100, lineTotalCents: 100 }] });
    expect((await cancelDraftPo(db, { poId: "po-draft", buyerTenantId: "buyer-2" })).reason).toBe("forbidden");
    expect((await cancelDraftPo(db, { poId: "po-draft", buyerTenantId: "buyer-1" })).ok).toBe(true);
    expect(store.purchaseOrders).toHaveLength(0);
    expect(store.poItems).toHaveLength(0);
    const submitted = seedPo({ id: "po-2", status: "submitted" });
    const { db: db2 } = makeDb({ purchaseOrders: [submitted] });
    expect((await cancelDraftPo(db2, { poId: "po-2", buyerTenantId: "buyer-1" })).reason).toBe("wrong_status");
  });

  it("markPoFulfilled transitions approved/invoiced/paid → fulfilled", async () => {
    const { db, store } = makeDb({ purchaseOrders: [seedPo({ id: "po-1", status: "invoiced" })] });
    expect((await markPoFulfilled(db, { poId: "po-1" })).ok).toBe(true);
    expect(store.purchaseOrders[0].status).toBe("fulfilled");
  });

  it("supplier-side ownership: other tenants cannot act on the PO", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1" })] });
    const out = await handlePoAction({ db, tenantId: "supplier-2", phone: "+2348000000099", action: "approve", poId: "po-1" });
    expect(out.reply).toContain("couldn't find");
    expect(credit.drawOnCredit).not.toHaveBeenCalled();
    const po = await getPoById(db, "po-1");
    expect(po?.status).toBe("submitted");
  });

  it("actions on non-submitted POs are no-ops", async () => {
    const { db } = makeDb({ purchaseOrders: [seedPo({ id: "po-1", status: "invoiced" })] });
    const out = await handlePoAction({ db, tenantId: "supplier-1", phone: "+2348000000010", action: "approve", poId: "po-1" });
    expect(out.reply).toContain("no action needed");
  });
});

// ── MOQ ─────────────────────────────────────────────────────────────────────
describe("MOQ enforcement", () => {
  it("submit below MOQ is rejected with the supplier's MOQ", async () => {
    const { db } = makeDb({ supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", moqCents: 100_000 })] });
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result).toMatchObject({ ok: false, reason: "below_moq", moqCents: 100_000 });
  });

  it("submit to an inactive supplier is rejected", async () => {
    const { db } = makeDb({ supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", status: "paused" })] });
    const result = await submitPurchaseOrder(db, {
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", lines: LINES, paymentMode: "credit",
    });
    expect(result).toMatchObject({ ok: false, reason: "supplier_inactive" });
  });
});

// ── WhatsApp buyer chat flow (end-to-end) ────────────────────────────────────
describe("buyer chat flow", () => {
  function seedCatalogDb() {
    return makeDb({
      supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", moqCents: 20_000, termsOffered: [7, 14] })],
      products: [
        { id: "p1", tenantId: "supplier-1", sku: "A", name: "Rice 50kg", price: "400.00", currency: "NGN", status: "active", stockQuantity: 9, metadata: null },
        { id: "p2", tenantId: "supplier-1", sku: "B", name: "Beans 25kg", price: "250.00", currency: "NGN", status: "active", stockQuantity: 9, metadata: null },
      ],
      wholesaleTiers: [
        { id: "t2", tenantId: "supplier-1", productId: "p2", buyerType: "wholesale", minQuantity: 5, unitPrice: "200.00", currency: "NGN" },
      ],
    });
  }
  const ctxFor = (db: any) => ({ db, tenantId: "buyer-1", phone: "+2348000000001", customerName: "Ada" });

  it("entry → suppliers → catalog → add (min qty) → review → terms → confirm submits the PO", async () => {
    const { db, store } = seedCatalogDb();
    credit.getCreditAccount.mockResolvedValue({ id: "acct-1", status: "active", limitCents: 1_000_000, outstandingCents: 0, termsDays: 14 } as any);
    const ctx = ctxFor(db);

    let out = await handleProcurementChat(ctx, {}, "");
    expect(out.reply).toContain("Browse suppliers");
    expect(out.nextState?.step).toBe("entry");

    out = await handleProcurementChat(ctx, { step: "entry", data: {} }, "1");
    expect(out.reply).toContain("Ada Wholesale");
    const chooseData = out.nextState!.data!;

    out = await handleProcurementChat(ctx, { step: "choose_supplier", data: chooseData }, "1");
    expect(out.reply).toContain("wholesale catalog");
    expect(out.reply).toContain("Beans 25kg");
    let browseData = out.nextState!.data!;

    // below tier min qty → refused
    out = await handleProcurementChat(ctx, { step: "browse", data: browseData }, "add 2 3");
    expect(out.reply).toContain("minimum quantity of 5");

    out = await handleProcurementChat(ctx, { step: "browse", data: browseData }, "add 2 5");
    expect(out.reply).toContain("Added Beans 25kg");
    browseData = out.nextState!.data!;

    // subtotal 5×20000 = 100_000 ≥ MOQ 20_000 → review with credit option
    out = await handleProcurementChat(ctx, { step: "browse", data: browseData }, "done");
    expect(out.reply).toContain("Review your PO");
    expect(out.reply).toContain("Pay on credit (net 7/14d)");
    const payData = out.nextState!.data!;

    out = await handleProcurementChat(ctx, { step: "choose_payment", data: payData }, "1");
    expect(out.reply).toContain("Net 7 days");
    const termsData = out.nextState!.data!;

    out = await handleProcurementChat(ctx, { step: "choose_terms", data: termsData }, "2");
    expect(out.reply).toContain("net 14 days");
    const confirmData = out.nextState!.data!;

    out = await handleProcurementChat(ctx, { step: "confirm", data: confirmData }, "CONFIRM");
    expect(out.reply).toContain("submitted to Ada Wholesale");
    expect(out.nextState).toBeNull();
    expect(store.purchaseOrders).toHaveLength(1);
    expect(store.purchaseOrders[0]).toMatchObject({
      buyerTenantId: "buyer-1", supplierTenantId: "supplier-1", status: "submitted",
      paymentMode: "credit", termsDays: 14, subtotalCents: 100_000, buyerPhone: "+2348000000001",
    });
    expect(store.poItems[0]).toMatchObject({ name: "Beans 25kg", qty: 5, unitPriceCents: 20_000 });
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1); // supplier action card
  });

  it("done below MOQ keeps the buyer in browse with a clear message", async () => {
    const { db } = seedCatalogDb();
    const ctx = ctxFor(db);
    const browseData = {
      supplierId: "supplier-1", supplierName: "Ada Wholesale", moqCents: 20_000,
      termsOffered: [14], defaultTermsDays: 14,
      catalog: [{ ref: "p1", name: "Rice 50kg", priceCents: 40_000, minQty: 1 }],
      cart: [] as any[],
    };
    let out = await handleProcurementChat(ctx, { step: "browse", data: browseData }, "done");
    expect(out.reply).toContain("cart is empty");
    // a real but too-small cart → MOQ message, stays in browse:
    out = await handleProcurementChat(ctx, { step: "browse", data: { ...browseData, cart: [{ ref: "p1", name: "Rice 50kg", qty: 1, unitPriceCents: 10_000 }] } }, "done");
    expect(out.reply).toContain("Minimum order");
    expect(out.nextState?.step).toBe("browse");
  });

  it("review without a credit account offers pay-now only", async () => {
    const { db } = seedCatalogDb();
    credit.getCreditAccount.mockResolvedValue(null);
    const ctx = ctxFor(db);
    const browseData = {
      supplierId: "supplier-1", supplierName: "Ada Wholesale", moqCents: 0,
      termsOffered: [14], defaultTermsDays: 14,
      catalog: [{ ref: "p1", name: "Rice 50kg", priceCents: 40_000, minQty: 1 }],
      cart: [{ ref: "p1", name: "Rice 50kg", qty: 1, unitPriceCents: 40_000 }],
    };
    const out = await handleProcurementChat(ctx, { step: "browse", data: browseData }, "done");
    expect(out.reply).not.toContain("Pay on credit");
    expect(out.reply).toContain("1. Pay now");
  });

  it("frozen credit account hides the credit option", async () => {
    const { db } = seedCatalogDb();
    credit.getCreditAccount.mockResolvedValue({ id: "acct-1", status: "frozen", limitCents: 9_999_999, outstandingCents: 0 } as any);
    const ctx = ctxFor(db);
    const browseData = {
      supplierId: "supplier-1", supplierName: "Ada Wholesale", moqCents: 0,
      termsOffered: [14], defaultTermsDays: 14,
      catalog: [], cart: [{ ref: "p1", name: "Rice", qty: 1, unitPriceCents: 40_000 }],
    };
    const out = await handleProcurementChat(ctx, { step: "browse", data: browseData }, "done");
    expect(out.reply).not.toContain("Pay on credit");
  });

  it("supplier-side entry surfaces the wholesale-orders inbox", async () => {
    const { db } = seedCatalogDb();
    const ctx = { db, tenantId: "supplier-1", phone: "+2348000000010" };
    let out = await handleProcurementChat(ctx, {}, "");
    expect(out.reply).toContain("Incoming wholesale orders");
    out = await handleProcurementChat(ctx, { step: "entry", data: { hasSupplierInbox: true } }, "3");
    expect(out.reply).toContain("awaiting your approval");
  });
});
