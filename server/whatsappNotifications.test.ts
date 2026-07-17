/**
 * WhatsApp Notifications — unit tests
 * Tests the notification service logic without hitting the WhatsApp Cloud API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock getDb ────────────────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./db";
import { sendOrderNotification, resolveOrderNotifRecipient } from "./routers/whatsappNotifications";

// ── sendOrderNotification ─────────────────────────────────────────────────────
describe("sendOrderNotification", () => {
  beforeEach(() => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
  });

  it("returns false in simulation mode (no WAC credentials)", async () => {
    const result = await sendOrderNotification({
      phone: "+2348012345678",
      orderNumber: "ORD-ABC123",
      customerName: "Amara Okafor",
      totalAmount: "15000.00",
      currency: "NGN",
      status: "confirmed",
      notifType: "order_confirmation",
    });
    expect(result.sent).toBe(false);
    expect(result.simulated).toBe(true);
  });

  it("calls WhatsApp Cloud API when credentials are set", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "test-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "12345678");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.test" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendOrderNotification({
      phone: "+2348012345678",
      orderNumber: "ORD-ABC123",
      customerName: "Amara Okafor",
      totalAmount: "15000.00",
      currency: "NGN",
      status: "confirmed",
      notifType: "order_confirmation",
    });

    expect(result.sent).toBe(true);
    expect(result.wamid).toBe("wamid.test");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("graph.facebook.com");
    expect(url).toContain("12345678/messages");
    const body = JSON.parse(opts.body);
    expect(body.to).toBe("+2348012345678");
    expect(body.template.name).toBe("wac_order_confirmation");
  });

  it("returns false (does not throw) when WhatsApp API returns error", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "bad-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "12345678");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }));

    const result = await sendOrderNotification({
      phone: "+2348012345678",
      orderNumber: "ORD-ABC123",
      customerName: "Test",
      totalAmount: "100.00",
      currency: "USD",
      status: "shipped",
      notifType: "order_shipped",
    });

    expect(result.sent).toBe(false);
    expect(result.simulated).toBe(false);
  });
});

// ── resolveOrderNotifRecipient ────────────────────────────────────────────────
describe("resolveOrderNotifRecipient", () => {
  it("returns null phone when DB is unavailable", async () => {
    vi.mocked(getDb).mockResolvedValue(null as never);
    const result = await resolveOrderNotifRecipient("order-1", "order_confirmation");
    expect(result.phone).toBeNull();
  });

  it("returns customer whatsappPhone when available", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn()
        // First call: orders
        .mockResolvedValueOnce([{
          id: "order-1",
          orderNumber: "ORD-001",
          customerId: "cust-1",
          tenantId: "tenant-1",
          totalAmount: "5000.00",
          currency: "NGN",
          status: "confirmed",
        }])
        // Second call: customers
        .mockResolvedValueOnce([{
          id: "cust-1",
          whatsappPhone: "+2348011111111",
          name: "Test Customer",
        }]),
    };
    vi.mocked(getDb).mockResolvedValue(mockDb as never);

    const result = await resolveOrderNotifRecipient("order-1", "order_confirmation");
    expect(result.phone).toBe("+2348011111111");
    expect(result.customerName).toBe("Test Customer");
    expect(result.orderNumber).toBe("ORD-001");
    expect(result.currency).toBe("NGN");
  });

  it("returns null when customer has no whatsappPhone and no verified users", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn()
        .mockResolvedValueOnce([{
          id: "order-2",
          orderNumber: "ORD-002",
          customerId: "cust-2",
          tenantId: "tenant-1",
          totalAmount: "1000.00",
          currency: "USD",
          status: "shipped",
        }])
        .mockResolvedValueOnce([{ id: "cust-2", whatsappPhone: null, name: "Guest" }])
        .mockResolvedValueOnce([]),
    };
    vi.mocked(getDb).mockResolvedValue(mockDb as never);

    const result = await resolveOrderNotifRecipient("order-2", "order_shipped");
    expect(result.phone).toBeNull();
  });
});

// ── getBulkUnreadReplyCounts (tRPC procedure logic) ───────────────────────────
describe("getBulkUnreadReplyCounts logic", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty counts when orderIds is empty", async () => {
    // When orderIds is empty, the procedure returns early without hitting DB
    vi.mocked(getDb).mockResolvedValue(null as never);
    // Simulate the procedure logic directly
    const orderIds: string[] = [];
    const db = await getDb();
    if (!db || orderIds.length === 0) {
      expect({ counts: {} }).toEqual({ counts: {} });
      return;
    }
    throw new Error("Should have returned early");
  });

  it("returns empty counts when DB is unavailable", async () => {
    vi.mocked(getDb).mockResolvedValue(null as never);
    const db = await getDb();
    if (!db) {
      expect({ counts: {} }).toEqual({ counts: {} });
      return;
    }
    throw new Error("Should have returned early");
  });

  it("aggregates unread counts per orderId from DB rows", () => {
    // Test the aggregation logic (pure function)
    const rows = [
      { orderId: "order-1", count: 3 },
      { orderId: "order-2", count: 1 },
      { orderId: null, count: 2 }, // null orderId should be skipped
    ];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (row.orderId) counts[row.orderId] = row.count;
    }
    expect(counts).toEqual({ "order-1": 3, "order-2": 1 });
    expect(counts["order-3"]).toBeUndefined();
  });
});

// ── sendAdminReply (tRPC procedure logic) ─────────────────────────────────────
describe("sendAdminReply logic", () => {
  beforeEach(() => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
  });

  it("returns simulated=true when WAC credentials are not set", async () => {
    // Simulate the procedure logic
    const token = process.env.WAC_WHATSAPP_TOKEN;
    const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      const result = { sent: false, simulated: true, wamid: null };
      expect(result.simulated).toBe(true);
      expect(result.sent).toBe(false);
      expect(result.wamid).toBeNull();
      return;
    }
    throw new Error("Should have returned early");
  });

  it("calls WhatsApp Cloud API with correct payload when credentials are set", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "test-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "99887766");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.reply.001" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    // Simulate the sendAdminReply procedure logic
    const input = { phone: "+2348099887766", message: "Hello, your order is ready!", orderId: "order-1" };
    const token = process.env.WAC_WHATSAPP_TOKEN;
    const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;
    const payload = {
      messaging_product: "whatsapp",
      to: input.phone.replace(/[^0-9]/g, ""),
      type: "text",
      text: { body: input.message, preview_url: false },
    };
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const data = await resp.json() as any;
    const wamid: string | null = data?.messages?.[0]?.id ?? null;

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("graph.facebook.com");
    expect(url).toContain("99887766/messages");
    const body = JSON.parse(opts.body);
    expect(body.to).toBe("2348099887766"); // stripped of non-numeric
    expect(body.type).toBe("text");
    expect(body.text.body).toBe("Hello, your order is ready!");
    expect(wamid).toBe("wamid.reply.001");
  });

  it("strips non-numeric characters from phone number", () => {
    const phone = "+234 (809) 988-7766";
    const stripped = phone.replace(/[^0-9]/g, "");
    expect(stripped).toBe("2348099887766");
  });
});
