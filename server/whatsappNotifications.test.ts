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
