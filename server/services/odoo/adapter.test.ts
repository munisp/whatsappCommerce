/**
 * W28 odoo-sync — adapter unit tests (pure/deterministic parts).
 * MockOdooAdapter ids, state inspectability, failure injection, and payload
 * builders. Db-backed worker/registry paths run end-to-end in J154–J157.
 */
import { describe, it, expect } from "vitest";
import { MockOdooAdapter, mockOdooId, OdooRpcError } from "./adapter";
import { buildExpensePayload, buildLoanPayload, buildPayoutPayload, buildSalePayload } from "./sync";

describe("mockOdooId", () => {
  it("is deterministic per (tenant, model, payload)", () => {
    const a = mockOdooId("t1", "account.payment", { reference: "X", amountCents: 100 });
    const b = mockOdooId("t1", "account.payment", { reference: "X", amountCents: 100 });
    expect(a).toBe(b);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThan(0);
  });
  it("is key-order independent and tenant/model sensitive", () => {
    const a = mockOdooId("t1", "m", { x: 1, y: 2 });
    const b = mockOdooId("t1", "m", { y: 2, x: 1 });
    expect(a).toBe(b);
    expect(mockOdooId("t2", "m", { x: 1 })).not.toBe(mockOdooId("t1", "m", { x: 1 }));
    expect(mockOdooId("t1", "m2", { x: 1 })).not.toBe(mockOdooId("t1", "m", { x: 1 }));
  });
});

describe("MockOdooAdapter", () => {
  it("records full inspectable state and resolves partners by ref", async () => {
    const m = new MockOdooAdapter("t1");
    const auth = await m.authenticate();
    expect(auth.uid).toBeGreaterThan(0);

    const inv = await m.createInvoice({
      partnerRef: "customer:c1",
      partnerName: "WhatsApp Customer c1",
      reference: "ORD-1",
      lines: [{ description: "Order ORD-1", quantity: 1, unitPriceCents: 250000 }],
      currency: "NGN",
      totalCents: 250000,
    });
    expect(inv.invoiceId).toBeGreaterThan(0);
    expect(m.state.invoices).toHaveLength(1);
    expect(m.state.invoices[0].input.totalCents).toBe(250000);
    // partner created once and reused by ref
    const p1 = await m.createPartner("customer:c1", "WhatsApp Customer c1");
    expect(p1.partnerId).toBe(m.state.invoices[0].partnerId);
    expect(m.state.partners).toHaveLength(1);
  });

  it("failNext injects deterministic failures then recovers", async () => {
    const m = new MockOdooAdapter("t1");
    m.failNext = 1;
    await expect(m.createPayment({
      paymentType: "outbound", reference: "WD-1", amountCents: 500, currency: "NGN",
    })).rejects.toBeInstanceOf(OdooRpcError);
    const ok = await m.createPayment({
      paymentType: "outbound", reference: "WD-1", amountCents: 500, currency: "NGN",
    });
    expect(ok.paymentId).toBeGreaterThan(0);
    expect(m.state.payments).toHaveLength(1);
  });

  it("attaches receipts to vendor bills", async () => {
    const m = new MockOdooAdapter("t1");
    const { billId } = await m.createVendorBill({
      vendorName: "Musa Supplies", reference: "EXP-1", amountCents: 42000, currency: "NGN",
    });
    const att = await m.attachReceipt({ billId, name: "receipt-EXP-1", base64: "QUJD", mimeType: "image/jpeg" });
    expect(att.attachmentId).toBeGreaterThan(0);
    expect(m.state.attachments[0].att.billId).toBe(billId);
  });
});

describe("payload builders (integer cents)", () => {
  it("buildSalePayload converts decimal major to integer cents", () => {
    const p = buildSalePayload({
      id: "o1", orderNumber: "ORD-100", customerId: "c9",
      totalAmount: "2500.50", currency: "NGN",
    });
    expect(p.totalCents).toBe(250050);
    expect(p.lines[0].unitPriceCents).toBe(250050);
    expect(p.reference).toBe("ORD-100");
    expect(p.partnerRef).toBe("customer:c9");
  });
  it("buildSalePayload rounds float drift safely", () => {
    const p = buildSalePayload({ id: "o2", totalAmount: 19.99 });
    expect(p.totalCents).toBe(1999);
  });
  it("buildExpensePayload keeps integer cents + metadata", () => {
    const p = buildExpensePayload({
      id: "e1", vendor: "Musa", amountCents: 42000, currency: "NGN",
      category: "stock", note: "n", expenseDate: new Date("2026-02-14T10:00:00Z"), mediaId: "m1",
    });
    expect(p.amountCents).toBe(42000);
    expect(p.expenseDate).toBe("2026-02-14");
    expect(p.reference).toBe("EXP-e1");
  });
  it("buildPayoutPayload / buildLoanPayload", () => {
    const p = buildPayoutPayload({ id: "w1", amount: "1000.00", currency: "NGN", reference: "r1" });
    expect(p.amountCents).toBe(100000);
    expect(p.paymentType).toBe("outbound");
    const l = buildLoanPayload({ id: "l1", principalCents: 500000, currency: "NGN", tier: "t2" });
    expect(l.amountCents).toBe(500000);
    expect(l.reference).toBe("LOAN-l1");
  });
});
