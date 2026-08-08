/**
 * Receipt-screenshot verification — unit tests
 * Amount parse/match helpers + match/mismatch branching with a mocked vision
 * scan, mocked db, mocked shared payment-confirm path, and mocked sender.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./services/receiptVision", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/receiptVision")>();
  return { ...orig, analyzeReceiptImage: vi.fn() };
});
vi.mock("./services/paymentConfirm", () => ({ confirmProviderPayment: vi.fn() }));
vi.mock("./services/waSender", () => ({
  resolveTenantWaCredentials: vi.fn(),
  sendWhatsAppText: vi.fn().mockResolvedValue({ sent: true, simulated: false, wamids: [], chunks: 1 }),
}));

import { getDb } from "./db";
import { analyzeReceiptImage, parseReceiptAmount, receiptAmountMatches } from "./services/receiptVision";
import { confirmProviderPayment } from "./services/paymentConfirm";
import { resolveTenantWaCredentials, sendWhatsAppText } from "./services/waSender";
import { handleInboundReceiptImage } from "./services/receiptVerification";

const ORDER = {
  id: "order-1",
  tenantId: "t1",
  customerId: "2348012345678",
  orderNumber: "ORD-TEST1",
  status: "pending",
  paymentStatus: "unpaid",
  totalAmount: "6300.00",
  currency: "NGN",
  createdAt: new Date(),
};

function makeDb(order: any | null, tx: any | null) {
  // Select order: 1st = direct order lookup (a hit short-circuits the
  // customers lookup); next = customers (miss path); next = via-customer
  // orders; last = payment transaction lookup.
  const selectResults: any[][] = order
    ? [[order], tx ? [tx] : []]
    : [[], [], []];
  let call = 0;
  const limit = vi.fn().mockImplementation(() => Promise.resolve(selectResults[call++] ?? []));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy, limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  (getDb as any).mockResolvedValue({ select, update });
  return { select, update, set };
}

function stubMediaDownload() {
  (resolveTenantWaCredentials as any).mockResolvedValue({
    phoneNumberId: "p", accessToken: "t", source: "env",
  });
  const buf = new TextEncoder().encode("fake-image-bytes").buffer;
  const mockFetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn.example/media", mime_type: "image/jpeg" }) })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => buf });
  vi.stubGlobal("fetch", mockFetch);
}

describe("receipt amount helpers", () => {
  it("parses Naira amounts from receipt text", () => {
    expect(parseReceiptAmount("₦6,300.00")).toBe(6300);
    expect(parseReceiptAmount("NGN 12,500")).toBe(12500);
    expect(parseReceiptAmount("Amount: 6300.00")).toBe(6300);
    expect(parseReceiptAmount("no amount here")).toBeNull();
  });

  it("matches within ±₦100 tolerance", () => {
    expect(receiptAmountMatches(6300, 6300)).toBe(true);
    expect(receiptAmountMatches(6250, 6300)).toBe(true);
    expect(receiptAmountMatches(6200, 6300)).toBe(true);
    expect(receiptAmountMatches(6100, 6300)).toBe(false);
    expect(receiptAmountMatches(6500, 6300)).toBe(false);
  });
});

describe("handleInboundReceiptImage branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMediaDownload();
  });

  it("MATCH: confirms via the shared payment path and replies confirmed", async () => {
    makeDb(ORDER, { id: "tx-1", providerRef: "ref-1", provider: "paystack", currency: "NGN", status: "initiated" });
    (analyzeReceiptImage as any).mockResolvedValue({
      isReadable: true, clarityScore: 90, clarityIssues: [], documentType: "screenshot",
      extractedText: "Transfer successful ₦6,300.00", keyFields: { amount: "₦6,300.00" },
      confidence: 95, summary: "Bank transfer receipt for ₦6,300",
    });
    (confirmProviderPayment as any).mockResolvedValue({ ok: true, action: "confirmed" });

    const result = await handleInboundReceiptImage({
      tenantId: "t1", waPhoneNumber: "2348012345678", mediaId: "media-1",
    });

    expect(result.outcome).toBe("confirmed");
    // SAME money path as the provider webhooks — called with the order's
    // expected amount, parsed receipt amount recorded in rawPayload.
    expect(confirmProviderPayment).toHaveBeenCalledOnce();
    const [, confirmOpts] = (confirmProviderPayment as any).mock.calls[0];
    expect(confirmOpts).toMatchObject({
      reference: "ref-1",
      amountMajor: 6300,
      currency: "NGN",
    });
    expect(confirmOpts.rawPayload).toMatchObject({ source: "wa_receipt_scan", parsedAmount: 6300 });
    const [, , replyBody] = (sendWhatsAppText as any).mock.calls[0];
    expect(replyBody).toMatch(/Payment received for order ORD-TEST1/);
    expect(replyBody).toMatch(/confirmed/);
  });

  it("MISMATCH: flags receiptReview and replies manual review, never confirms", async () => {
    const { update } = makeDb(ORDER, { id: "tx-1", providerRef: "ref-1", provider: "paystack", currency: "NGN", status: "initiated" });
    (analyzeReceiptImage as any).mockResolvedValue({
      isReadable: true, clarityScore: 90, clarityIssues: [], documentType: "screenshot",
      extractedText: "Transfer successful ₦3,000.00", keyFields: { amount: "₦3,000.00" },
      confidence: 95, summary: "Bank transfer receipt for ₦3,000",
    });

    const result = await handleInboundReceiptImage({
      tenantId: "t1", waPhoneNumber: "2348012345678", mediaId: "media-1",
    });

    expect(result.outcome).toBe("manual_review");
    expect(confirmProviderPayment).not.toHaveBeenCalled();
    // order flagged for review
    expect(update).toHaveBeenCalled();
    const [, , replyBody] = (sendWhatsAppText as any).mock.calls[0];
    expect(replyBody).toMatch(/manual review/);
  });

  it("does nothing when there is no recent pending order", async () => {
    makeDb(null, null);
    const result = await handleInboundReceiptImage({
      tenantId: "t1", waPhoneNumber: "2348012345678", mediaId: "media-1",
    });
    expect(result.outcome).toBe("no_pending_order");
    expect(analyzeReceiptImage).not.toHaveBeenCalled();
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});
