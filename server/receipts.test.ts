/**
 * Digital receipt tests: message content (itemized lines, discount, delivery
 * fee, total, payment ref, delivery PIN, tracking link) and the sendOrderReceipt
 * data path (buyer phone resolution, branding name, shipment PIN lookup).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, sendWhatsAppText: vi.fn() };
});

import { sendWhatsAppText } from "./services/waSender";
import { buildReceiptMessage, sendOrderReceipt, parseReceiptItems } from "./services/receipts";
import { orders, customers, tenants, logisticsShipments } from "../drizzle/schema";

function sqlParams(v: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (c: unknown): void => {
    if (c == null) return;
    if (Array.isArray(c)) return c.forEach(walk);
    const t = typeof c;
    if (t === "string" || t === "number" || t === "boolean" || c instanceof Date) {
      out.push(c);
      return;
    }
    if (t !== "object") return;
    const o = c as Record<string, unknown>;
    const ctor = (o.constructor as { name?: string } | undefined)?.name;
    if (ctor === "StringChunk" || ctor === "Column") return;
    if (Array.isArray(o.queryChunks)) return walk(o.queryChunks);
    if ("value" in o) {
      out.push(o.value);
      return;
    }
  };
  walk((v as { queryChunks?: unknown[] })?.queryChunks ?? v);
  return out;
}

const ORDER = {
  id: "order-1",
  tenantId: "t1",
  customerId: "cust-1",
  orderNumber: "ORD-ABC123",
  totalAmount: "4750.00",
  currency: "NGN",
  items: [
    { productId: "p1", name: "Spicy Wrap", qty: 2, price: "2500.00" },
    { productId: "p2", productName: "Chapman", quantity: 1, unitPrice: "1500.00" },
  ],
  metadata: {
    fulfillment: "delivery",
    subtotal: "6500.00",
    deliveryFee: "1250.00",
    promo: { code: "SAVE10", type: "percent", value: 10, discount: "3000.00" },
  },
};

function makeDb(seed: {
  order?: Record<string, unknown> | null;
  customer?: Record<string, unknown> | null;
  tenant?: Record<string, unknown> | null;
  shipment?: Record<string, unknown> | null;
}) {
  const db: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          void sqlParams(cond);
          const row =
            table === orders ? seed.order
            : table === customers ? seed.customer
            : table === tenants ? seed.tenant
            : table === logisticsShipments ? seed.shipment
            : null;
          const rows = row ? [row] : [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWhatsAppText).mockResolvedValue({ sent: true, simulated: false, wamids: ["w"], chunks: 1 });
});

describe("buildReceiptMessage", () => {
  it("includes business name, lines, discount, delivery fee, total, ref, PIN, tracking", () => {
    const msg = buildReceiptMessage({
      businessName: "Ada’s Kitchen",
      orderNumber: "ORD-ABC123",
      items: [
        { name: "Spicy Wrap", qty: 2, unitPrice: 2500 },
        { name: "Chapman", qty: 1, unitPrice: 1500 },
      ],
      subtotal: 6500,
      deliveryFee: 1250,
      promo: { code: "SAVE10", discount: 3000 },
      total: 4750,
      currency: "NGN",
      paymentRef: "PAY-123",
      deliveryPin: "4821",
      trackingUrl: "https://app.example.com/track/token",
    });
    expect(msg).toMatch(/Ada’s Kitchen/);
    expect(msg).toMatch(/ORD-ABC123/);
    expect(msg).toMatch(/2 × Spicy Wrap/);
    expect(msg).toMatch(/1 × Chapman/);
    expect(msg).toMatch(/Discount \(SAVE10\): −₦3,000\.00/);
    expect(msg).toMatch(/Delivery fee: ₦1,250\.00/);
    expect(msg).toMatch(/Total paid: ₦4,750\.00/);
    expect(msg).toMatch(/Payment ref: PAY-123/);
    expect(msg).toMatch(/delivery PIN: \*4821\*/);
    expect(msg).toMatch(/https:\/\/app\.example\.com\/track\/token/);
  });

  it("omits discount and PIN lines when absent", () => {
    const msg = buildReceiptMessage({
      businessName: "Store",
      orderNumber: "ORD-1",
      items: [{ name: "Wrap", qty: 1, unitPrice: 100 }],
      subtotal: 100,
      deliveryFee: 0,
      promo: null,
      total: 100,
      currency: "NGN",
      paymentRef: "REF",
      deliveryPin: null,
      trackingUrl: "https://x/track/t",
    });
    expect(msg).not.toMatch(/Discount/);
    expect(msg).not.toMatch(/PIN/);
    expect(msg).not.toMatch(/Delivery fee/);
  });
});

describe("parseReceiptItems", () => {
  it("handles chat-flow and orderCrud item shapes", () => {
    const items = parseReceiptItems(ORDER.items);
    expect(items).toEqual([
      { name: "Spicy Wrap", qty: 2, unitPrice: 2500 },
      { name: "Chapman", qty: 1, unitPrice: 1500 },
    ]);
    expect(parseReceiptItems(null)).toEqual([]);
    expect(parseReceiptItems([{ qty: -1 }])).toEqual([]);
  });
});

describe("sendOrderReceipt", () => {
  it("sends the receipt to the customer phone with exact order figures", async () => {
    const db = makeDb({
      order: ORDER,
      customer: { whatsappPhone: "+2348011111111" },
      tenant: { name: "Fallback", settings: { branding: { name: "Ada’s Kitchen" } } },
      shipment: { deliveryPin: "4821" },
    });
    const r = await sendOrderReceipt(db, "order-1", "PAY-123");
    expect(r.sent).toBe(true);
    expect(sendWhatsAppText).toHaveBeenCalledTimes(1);
    const [tenantId, toPhone, body, opts] = vi.mocked(sendWhatsAppText).mock.calls[0];
    expect(tenantId).toBe("t1");
    expect(toPhone).toBe("+2348011111111");
    expect(opts?.orderId).toBe("order-1");
    expect(body).toMatch(/Ada’s Kitchen/); // settings.branding.name wins
    expect(body).toMatch(/Discount \(SAVE10\): −₦3,000\.00/);
    expect(body).toMatch(/Total paid: ₦4,750\.00/); // from the order row, not recomputed
    expect(body).toMatch(/Payment ref: PAY-123/);
    expect(body).toMatch(/\*4821\*/); // delivery PIN from the shipment
    expect(body).toMatch(/\/track\//); // tracking link
  });

  it("falls back to customerId-as-phone (chat flow) and tenant name", async () => {
    const db = makeDb({
      order: { ...ORDER, customerId: "2348099999999", metadata: { subtotal: "6500.00" } },
      customer: null,
      tenant: { name: "Plain Store", settings: {} },
      shipment: null,
    });
    const r = await sendOrderReceipt(db, "order-1", "PAY-9");
    expect(r.sent).toBe(true);
    const [, toPhone, body] = vi.mocked(sendWhatsAppText).mock.calls[0];
    expect(toPhone).toBe("2348099999999");
    expect(body).toMatch(/Plain Store/);
    expect(body).not.toMatch(/PIN/);
    expect(body).not.toMatch(/Discount/);
  });

  it("skips cleanly when the order is missing", async () => {
    const db = makeDb({ order: null });
    const r = await sendOrderReceipt(db, "missing", "REF");
    expect(r).toEqual({ sent: false, reason: "order-not-found" });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});
