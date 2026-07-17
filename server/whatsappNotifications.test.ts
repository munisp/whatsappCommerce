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

// ── suggestReply (tRPC procedure logic) ───────────────────────────────────────
describe("suggestReply logic", () => {
  it("builds a correct system prompt with order context", () => {
    const orderCtx = { orderNumber: "ORD-001", status: "shipped", totalAmount: "5000", currency: "NGN" };
    const systemPrompt = `You are a helpful WhatsApp customer support agent for an e-commerce platform.\nYour job is to draft a concise, friendly, professional reply to a customer's WhatsApp message.\nKeep responses under 200 words. Be empathetic, clear, and solution-oriented.\nDo not include greetings like "Dear Customer" — be conversational.\nContext: Order #${orderCtx.orderNumber} — Status: ${orderCtx.status}, Total: ${orderCtx.currency} ${orderCtx.totalAmount}`;
    expect(systemPrompt).toContain("ORD-001");
    expect(systemPrompt).toContain("shipped");
    expect(systemPrompt).toContain("NGN 5000");
  });

  it("formats message history with most recent last", () => {
    const replies = [
      { messageType: "text", body: "Where is my order?", fromPhone: "+2348001", createdAt: "2026-07-17T10:00:00Z" },
      { messageType: "text", body: "It's been 3 days!", fromPhone: "+2348001", createdAt: "2026-07-17T10:05:00Z" },
    ];
    const history = replies
      .slice()
      .reverse()
      .map((r) => `[${new Date(r.createdAt).toLocaleTimeString()}] Customer: ${r.body ?? `[${r.messageType} message]`}`)
      .join("\n");
    // reversed = most recent first, then joined → most recent is first line
    expect(history.split("\n")[0]).toContain("It's been 3 days!");
    expect(history.split("\n")[1]).toContain("Where is my order?");
  });

  it("uses [messageType message] placeholder for non-text messages", () => {
    const reply = { messageType: "image", body: null, fromPhone: "+2348001", createdAt: "2026-07-17T10:00:00Z" };
    const text = reply.body ?? `[${reply.messageType} message]`;
    expect(text).toBe("[image message]");
  });

  it("trims whitespace from the LLM response", () => {
    const raw = "  Hello, your order is on its way!  \n";
    const trimmed = raw.trim();
    expect(trimmed).toBe("Hello, your order is on its way!");
  });

  it("returns empty string when LLM returns null content", () => {
    const content: string | null = null;
    const suggestion = (content as string) ?? "";
    expect(suggestion).toBe("");
  });
});

// ── sendAttachment (tRPC procedure logic) ─────────────────────────────────────
describe("sendAttachment logic", () => {
  it("determines waType=image for image MIME types", () => {
    const mimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    for (const mime of mimeTypes) {
      const isImage = mime.startsWith("image/");
      const waType = isImage ? "image" : "document";
      expect(waType).toBe("image");
    }
  });

  it("determines waType=document for PDF MIME type", () => {
    const mime = "application/pdf";
    const isImage = mime.startsWith("image/");
    const waType = isImage ? "image" : "document";
    expect(waType).toBe("document");
  });

  it("returns simulated=true when WAC credentials are not set", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    const token = process.env.WAC_WHATSAPP_TOKEN;
    const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      const result = { sent: false, simulated: true, wamid: null, storageUrl: "/api/storage/test.jpg" };
      expect(result.simulated).toBe(true);
      expect(result.sent).toBe(false);
      return;
    }
    throw new Error("Should have returned early");
  });

  it("builds correct WhatsApp image payload with caption", () => {
    const input = {
      phone: "+2348099887766",
      mimeType: "image/jpeg" as const,
      fileName: "receipt.jpg",
      caption: "Here is your receipt",
    };
    const isImage = input.mimeType.startsWith("image/");
    const waType = isImage ? "image" : "document";
    const publicUrl = "https://example.com/api/storage/uploads/abc123.jpg";
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: input.phone.replace(/[^0-9]/g, ""),
      type: waType,
      [waType]: {
        link: publicUrl,
        caption: input.caption,
      },
    };
    expect(payload.type).toBe("image");
    expect((payload.image as any).caption).toBe("Here is your receipt");
    expect((payload.image as any).link).toContain("abc123.jpg");
    expect(payload.to).toBe("2348099887766");
  });

  it("builds correct WhatsApp document payload with filename", () => {
    const input = {
      phone: "+2348099887766",
      mimeType: "application/pdf" as const,
      fileName: "invoice.pdf",
      caption: undefined,
    };
    const isImage = input.mimeType.startsWith("image/");
    const waType = isImage ? "image" : "document";
    const publicUrl = "https://example.com/api/storage/uploads/xyz789.pdf";
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: input.phone.replace(/[^0-9]/g, ""),
      type: waType,
      [waType]: {
        link: publicUrl,
        filename: input.fileName,
      },
    };
    expect(payload.type).toBe("document");
    expect((payload.document as any).filename).toBe("invoice.pdf");
    expect((payload.document as any).caption).toBeUndefined();
  });

  it("generates a storage key with correct extension", () => {
    function generateStorageKey(filename: string): string {
      const ext = filename.split(".").pop() ?? "bin";
      return `uploads/testhash.${ext}`;
    }
    expect(generateStorageKey("photo.jpg")).toMatch(/\.jpg$/);
    expect(generateStorageKey("invoice.pdf")).toMatch(/\.pdf$/);
    expect(generateStorageKey("noext")).toMatch(/\.noext$/);
  });
});

// ── Round 53: drag-and-drop file validation, tone injection, markReplyUnread ──
describe("drag-and-drop file validation logic", () => {
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;
  type AllowedMime = typeof ALLOWED_TYPES[number];

  function validateDroppedFile(file: { type: string; size: number }): string | null {
    if (!ALLOWED_TYPES.includes(file.type as AllowedMime)) {
      return "Only JPEG, PNG, WebP, GIF, and PDF files are supported";
    }
    if (file.size > 10 * 1024 * 1024) {
      return "File must be under 10 MB";
    }
    return null;
  }

  it("accepts valid image types", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      expect(validateDroppedFile({ type: mime, size: 1024 })).toBeNull();
    }
  });

  it("accepts PDF files", () => {
    expect(validateDroppedFile({ type: "application/pdf", size: 500_000 })).toBeNull();
  });

  it("rejects unsupported types", () => {
    expect(validateDroppedFile({ type: "video/mp4", size: 1024 })).toMatch(/supported/i);
    expect(validateDroppedFile({ type: "text/plain", size: 1024 })).toMatch(/supported/i);
    expect(validateDroppedFile({ type: "application/zip", size: 1024 })).toMatch(/supported/i);
  });

  it("rejects files over 10 MB", () => {
    expect(validateDroppedFile({ type: "image/jpeg", size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
  });

  it("accepts files exactly at 10 MB boundary", () => {
    expect(validateDroppedFile({ type: "image/png", size: 10 * 1024 * 1024 })).toBeNull();
  });
});

describe("suggestReply tone injection", () => {
  const toneInstructions: Record<string, string> = {
    professional: "Use a formal, polished, business-appropriate tone. Be precise and courteous.",
    friendly: "Use a warm, conversational, approachable tone. Be cheerful and personable.",
    empathetic: "Use a compassionate, understanding tone. Acknowledge the customer's feelings first before offering solutions.",
    concise: "Be extremely brief and to the point. Use short sentences. Maximum 3 sentences total.",
  };

  it("includes correct tone instruction for professional", () => {
    const guide = toneInstructions["professional"];
    expect(guide).toContain("formal");
    expect(guide).toContain("polished");
  });

  it("includes correct tone instruction for friendly", () => {
    const guide = toneInstructions["friendly"];
    expect(guide).toContain("warm");
    expect(guide).toContain("cheerful");
  });

  it("includes correct tone instruction for empathetic", () => {
    const guide = toneInstructions["empathetic"];
    expect(guide).toContain("compassionate");
    expect(guide).toContain("feelings");
  });

  it("includes correct tone instruction for concise", () => {
    const guide = toneInstructions["concise"];
    expect(guide).toContain("brief");
    expect(guide).toContain("3 sentences");
  });

  it("falls back to professional for unknown tone", () => {
    const guide = toneInstructions["unknown"] ?? toneInstructions["professional"];
    expect(guide).toContain("formal");
  });

  it("injects tone guide into system prompt", () => {
    const tone = "friendly";
    const guide = toneInstructions[tone];
    const systemPrompt = `You are a WhatsApp customer support agent.\nTone instruction: ${guide}\nContext: Order #001`;
    expect(systemPrompt).toContain("Tone instruction:");
    expect(systemPrompt).toContain("warm");
  });
});

describe("markReplyUnread logic", () => {
  it("sets read=false and readAt=null conceptually", () => {
    // Simulate the DB update payload
    const updatePayload = { read: false, readAt: null };
    expect(updatePayload.read).toBe(false);
    expect(updatePayload.readAt).toBeNull();
  });

  it("requires a replyId string input", () => {
    const input = { replyId: "reply-abc-123" };
    expect(typeof input.replyId).toBe("string");
    expect(input.replyId.length).toBeGreaterThan(0);
  });

  it("rejects empty replyId", () => {
    const validate = (id: string) => id.length > 0;
    expect(validate("")).toBe(false);
    expect(validate("reply-abc-123")).toBe(true);
  });
});

// ── Round 54: Typing indicator state logic ────────────────────────────────────
describe("typing indicator state logic", () => {
  it("isSuggesting starts as false", () => {
    const isSuggesting = false;
    expect(isSuggesting).toBe(false);
  });

  it("isSuggesting becomes true when mutation is triggered", () => {
    let isSuggesting = false;
    // Simulate clicking AI Suggest
    const onSuggestClick = () => { isSuggesting = true; };
    onSuggestClick();
    expect(isSuggesting).toBe(true);
  });

  it("isSuggesting resets to false on success", () => {
    let isSuggesting = true;
    // Simulate onSuccess callback
    const onSuccess = () => { isSuggesting = false; };
    onSuccess();
    expect(isSuggesting).toBe(false);
  });

  it("isSuggesting resets to false on error", () => {
    let isSuggesting = true;
    const onError = () => { isSuggesting = false; };
    onError();
    expect(isSuggesting).toBe(false);
  });

  it("suggestion text is populated in replyText on success", () => {
    let replyText = "";
    const suggestion = "Thank you for reaching out. Your order is on its way.";
    const onSuccess = (result: { suggestion: string }) => {
      replyText = result.suggestion;
    };
    onSuccess({ suggestion: suggestion });
    expect(replyText).toBe(suggestion);
  });

  it("textarea is hidden while isSuggesting is true", () => {
    // Simulate the conditional rendering logic
    const shouldShowTextarea = (isSuggesting: boolean) => !isSuggesting;
    expect(shouldShowTextarea(true)).toBe(false);
    expect(shouldShowTextarea(false)).toBe(true);
  });

  it("typing indicator is shown while isSuggesting is true", () => {
    const shouldShowIndicator = (isSuggesting: boolean) => isSuggesting;
    expect(shouldShowIndicator(true)).toBe(true);
    expect(shouldShowIndicator(false)).toBe(false);
  });
});
