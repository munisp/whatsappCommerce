/**
 * waCommerceSurface — WhatsApp commerce surface tests
 *  - waLocation: native location-request send (Graph payload + simulation)
 *  - locationInbound: location message → checkout continue / default address
 *  - metaCatalog: payload mapping, sync, delete, status persistence
 *  - visualSearch: vision → match → product card, no-match, flag off, receipt gate
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Shared module mocks ──────────────────────────────────────────────────────
vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./services/waLocation", () => ({ sendWhatsAppLocationRequest: vi.fn().mockResolvedValue({ sent: true, simulated: false }) }));
vi.mock("./services/waSender", () => ({
  resolveTenantWaCredentials: vi.fn(),
  normalizeWaPhone: (p: string) => p.replace(/[^\d]/g, ""),
  sendWhatsAppText: vi.fn().mockResolvedValue({ sent: true }),
  sendWhatsAppMedia: vi.fn().mockResolvedValue({ sent: true }),
  sendWhatsAppInteractive: vi.fn().mockResolvedValue({ sent: true }),
}));

import { getDb } from "./db";
import { invokeLLM } from "./_core/llm";
import { sendWhatsAppLocationRequest as sendLocationReqMock } from "./services/waLocation";
import {
  resolveTenantWaCredentials,
  sendWhatsAppMedia,
  sendWhatsAppText,
} from "./services/waSender";

const getDbMock = getDb as any;

/** Queue-based fake db: each select() consumes the next queued row-set;
 *  update/insert calls are recorded. */
function makeQueueDb(selectResults: unknown[][]) {
  const calls = { updateSets: [] as any[], insertValues: [] as any[] };
  const db = {
    select: vi.fn(() => {
      const rows = selectResults.shift() ?? [];
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn().mockResolvedValue(rows);
      // allow awaiting the chain itself (no .limit)
      chain.then = (res: any) => Promise.resolve(rows).then(res);
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        calls.updateSets.push(v);
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        calls.insertValues.push(v);
        return { returning: vi.fn().mockResolvedValue([v]), onConflictDoNothing: vi.fn().mockResolvedValue([]), then: (res: any) => Promise.resolve([]).then(res) };
      }),
    })),
  };
  return { db, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.1" }] }) }));
});
afterEach(() => vi.unstubAllGlobals());

// ── waLocation ───────────────────────────────────────────────────────────────
describe("sendWhatsAppLocationRequest", () => {
  it("posts an interactive location_request_message to the Graph API", async () => {
    (resolveTenantWaCredentials as any).mockResolvedValue({ phoneNumberId: "pn-1", accessToken: "tok", source: "tenant" });
    // importActual bypasses the module mock (which exists for other modules' imports).
    const { sendWhatsAppLocationRequest } = await vi.importActual<any>("./services/waLocation");
    const res = await sendWhatsAppLocationRequest("t1", "+234 801 234", "Share your location");
    expect(res.sent).toBe(true);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-1/messages");
    const body = JSON.parse(init.body);
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("location_request_message");
    expect(body.interactive.action.name).toBe("send_location");
    expect(body.to).toBe("234801234");
  });

  it("simulates when no credentials are configured", async () => {
    (resolveTenantWaCredentials as any).mockResolvedValue(null);
    const { sendWhatsAppLocationRequest } = await vi.importActual<any>("./services/waLocation");
    const res = await sendWhatsAppLocationRequest("t1", "234801", "hi");
    expect(res).toEqual({ sent: false, simulated: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── locationInbound ──────────────────────────────────────────────────────────
describe("locationInbound", () => {
  it("formatLocationAddress prefers name+address, falls back to coords", async () => {
    const { formatLocationAddress } = await import("./services/locationInbound");
    expect(formatLocationAddress({ latitude: 6.5, longitude: 3.3, name: "Shoprite", address: "Ikeja, Lagos" }))
      .toBe("Shoprite, Ikeja, Lagos");
    expect(formatLocationAddress({ latitude: 6.5244, longitude: 3.3792 }))
      .toBe("6.524400, 3.379200");
  });

  it("pending checkout: feeds address through nlp.processMessage and patches order coords", async () => {
    const session = { id: "s1", tenantId: "t1", waPhoneNumber: "234801", context: { awaitingAddress: true }, messageHistory: [] };
    const processMessage = vi.fn().mockResolvedValue({
      reply: "Order summary...",
      orderCard: { orderId: "o1", orderNumber: "ORD-1", paymentUrl: null },
    });
    vi.doMock("./routers", () => ({ appRouter: { createCaller: () => ({ nlp: { processMessage } }) } }));
    vi.resetModules();
    const { db, calls } = makeQueueDb([[session]]); // findSessionAwaitingAddress
    getDbMock.mockResolvedValue(db);
    const { handleInboundLocationMessage } = await import("./services/locationInbound");
    const out = await handleInboundLocationMessage({
      tenantId: "t1",
      waPhoneNumber: "234801",
      location: { latitude: 6.5, longitude: 3.3, name: "Home", address: "12 Allen Ave" },
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toBe("Order summary...");
    expect(out.orderCard?.orderId).toBe("o1");
    expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      waPhoneNumber: "234801",
      message: "Home, 12 Allen Ave",
    }));
    // coords patch on the order (metadata + shippingAddress jsonb merge)
    expect(calls.updateSets.length).toBe(1);
    expect(calls.updateSets[0]).toHaveProperty("metadata");
    expect(calls.updateSets[0]).toHaveProperty("shippingAddress");
    vi.doUnmock("./routers");
  });

  it("no pending session: saves default address and confirms", async () => {
    const { db, calls } = makeQueueDb([[], []]); // awaiting lookup empty, latest session empty
    getDbMock.mockResolvedValue(db);
    vi.resetModules();
    const { handleInboundLocationMessage } = await import("./services/locationInbound");
    const out = await handleInboundLocationMessage({
      tenantId: "t1",
      waPhoneNumber: "234801",
      location: { latitude: 6.5, longitude: 3.3, address: "12 Allen Ave" },
    });
    expect(out.savedAsDefault).toBe(true);
    expect(out.reply).toContain("default delivery address");
    expect(calls.insertValues.length).toBe(1);
    const ctx = calls.insertValues[0].context as any;
    expect(ctx.deliveryAddress).toBe("12 Allen Ave");
    expect(ctx.deliveryCoords).toEqual({ latitude: 6.5, longitude: 3.3 });
  });

  it("existing session: default address merged into session context", async () => {
    const { saveDefaultAddress } = await import("./services/locationInbound");
    const latest = { id: "s9", context: { fulfillment: "delivery" } };
    const { db, calls } = makeQueueDb([[latest]]);
    getDbMock.mockResolvedValue(db);
    await saveDefaultAddress(db as any, "t1", "234801", "Ada", { latitude: 1, longitude: 2, name: "Office" });
    expect(calls.updateSets.length).toBe(1);
    expect(calls.updateSets[0].context).toMatchObject({
      fulfillment: "delivery",
      deliveryAddress: "Office",
      deliveryCoords: { latitude: 1, longitude: 2 },
    });
  });
});

// ── metaCatalog ──────────────────────────────────────────────────────────────
describe("metaCatalog", () => {
  it("mapProductToMetaItem: price major+currency, availability from stock", async () => {
    const { mapProductToMetaItem } = await import("./services/metaCatalog");
    expect(mapProductToMetaItem({ id: "p1", name: "Rice 5kg", price: "12500.50", currency: "NGN", stockQuantity: 4 }))
      .toEqual({ retailer_id: "p1", name: "Rice 5kg", price: "12500.50 NGN", availability: "in stock" });
    const out = mapProductToMetaItem({ id: "p2", name: "Beans", price: 0, currency: "usd", stockQuantity: 0, description: "d", imageUrl: "https://x/y.jpg" });
    expect(out.price).toBe("0.00 USD");
    expect(out.availability).toBe("out of stock");
    expect(out.image_url).toBe("https://x/y.jpg");
  });

  it("syncCatalog batches UPDATE requests and persists status", async () => {
    const settings = { metaCatalog: { catalogId: "cat1", accessToken: "tok", enabled: true } };
    const prodRows = [
      { id: "p1", tenantId: "t1", name: "Rice", price: "100.00", currency: "NGN", stockQuantity: 3, status: "active", description: null, imageUrl: null },
      { id: "p2", tenantId: "t1", name: "Beans", price: "50.00", currency: "NGN", stockQuantity: 0, status: "active", description: null, imageUrl: null },
    ];
    const { db, calls } = makeQueueDb([[{ settings }], prodRows, [{ settings }]]);
    getDbMock.mockResolvedValue(db);
    vi.resetModules();
    const { syncCatalog } = await import("./services/metaCatalog");
    const res = await syncCatalog("t1");
    expect(res).toMatchObject({ synced: 2, failed: 0, lastError: null });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/cat1/items");
    const body = JSON.parse(init.body);
    expect(body.access_token).toBe("tok");
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({ method: "UPDATE", retailer_id: "p1" });
    expect(body.requests[0].data.price).toBe("100.00 NGN");
    expect(body.requests[1].data.availability).toBe("out of stock");
    // status persisted under settings.metaCatalog.status
    const statusWrite = calls.updateSets.find((s) => s.settings?.metaCatalog?.status);
    expect(statusWrite.settings.metaCatalog.status).toMatchObject({ lastAction: "full_sync", synced: 2, failed: 0 });
  });

  it("syncCatalog skips when disabled", async () => {
    const { db } = makeQueueDb([[{ settings: { metaCatalog: { enabled: false } } }]]);
    getDbMock.mockResolvedValue(db);
    const { syncCatalog } = await import("./services/metaCatalog");
    const res = await syncCatalog("t1");
    expect(res.skipped).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deleteCatalogItem sends DELETE and records failure status on error", async () => {
    const settings = { metaCatalog: { catalogId: "cat1", accessToken: "tok", enabled: true } };
    const { db, calls } = makeQueueDb([[{ settings }], [{ settings }]]);
    getDbMock.mockResolvedValue(db);
    (fetch as any).mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad" });
    const { deleteCatalogItem } = await import("./services/metaCatalog");
    const res = await deleteCatalogItem("t1", "p9");
    expect(res.failed).toBe(1);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.requests[0]).toEqual({ method: "DELETE", retailer_id: "p9" });
    const statusWrite = calls.updateSets.find((s) => s.settings?.metaCatalog?.status);
    expect(statusWrite.settings.metaCatalog.status.lastAction).toBe("delete");
    expect(statusWrite.settings.metaCatalog.status.lastError).toContain("400");
  });
});

// ── visualSearch ─────────────────────────────────────────────────────────────
describe("visualSearch", () => {
  it("shouldRunVisualSearchAfterReceipt gates on receipt claim", async () => {
    const { shouldRunVisualSearchAfterReceipt } = await import("./services/visualSearch");
    expect(shouldRunVisualSearchAfterReceipt({ handled: true, outcome: "no_pending_order" })).toBe(true);
    expect(shouldRunVisualSearchAfterReceipt({ handled: true, outcome: "confirmed" })).toBe(false);
    expect(shouldRunVisualSearchAfterReceipt({ handled: true, outcome: "manual_review" })).toBe(false);
    expect(shouldRunVisualSearchAfterReceipt({ handled: false })).toBe(false);
    expect(shouldRunVisualSearchAfterReceipt(null)).toBe(false);
  });

  function stubMediaDownload() {
    (resolveTenantWaCredentials as any).mockResolvedValue({ phoneNumberId: "pn", accessToken: "tok", source: "tenant" });
    (fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn/img.jpg", mime_type: "image/jpeg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Buffer.from("img").buffer });
  }

  it("image → vision → catalog match → product card with BUY hint", async () => {
    stubMediaDownload();
    (invokeLLM as any).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ itemName: "Red Dress", description: "A red dress" }) } }] });
    const { db } = makeQueueDb([
      [{ settings: {} }], // isVisualSearchEnabled
      [{ id: "p1", name: "Red Dress", price: "15000.00", currency: "NGN", stockQuantity: 2, imageUrl: "https://x/red.jpg", description: null }],
    ]);
    getDbMock.mockResolvedValue(db);
    vi.resetModules();
    const { handleInboundProductImage } = await import("./services/visualSearch");
    const out = await handleInboundProductImage({ tenantId: "t1", waPhoneNumber: "234801", mediaId: "m1" });
    expect(out).toMatchObject({ handled: true, matched: true, productId: "p1" });
    expect(sendWhatsAppMedia).toHaveBeenCalledWith(
      "t1", "234801",
      expect.objectContaining({ type: "image", link: "https://x/red.jpg", caption: expect.stringContaining("BUY Red Dress") }),
      expect.objectContaining({ notifType: "visual_search" }),
    );
  });

  it("no match → polite menu fallback", async () => {
    stubMediaDownload();
    (invokeLLM as any).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ itemName: "Snowboard", description: "A snowboard" }) } }] });
    const { db } = makeQueueDb([
      [{ settings: {} }],
      [{ id: "p1", name: "Red Dress", price: "15000.00", currency: "NGN", stockQuantity: 2, imageUrl: null, description: null }],
    ]);
    getDbMock.mockResolvedValue(db);
    const { handleInboundProductImage } = await import("./services/visualSearch");
    const out = await handleInboundProductImage({ tenantId: "t1", waPhoneNumber: "234801", mediaId: "m1" });
    expect(out).toMatchObject({ handled: true, matched: false });
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "t1", "234801",
      expect.stringContaining("couldn't find"),
      expect.objectContaining({ notifType: "visual_search" }),
    );
  });

  it("feature flag off → no-op (no vision call, no replies)", async () => {
    const { db } = makeQueueDb([[{ settings: { visualSearch: { enabled: false } } }]]);
    getDbMock.mockResolvedValue(db);
    const { handleInboundProductImage } = await import("./services/visualSearch");
    const out = await handleInboundProductImage({ tenantId: "t1", waPhoneNumber: "234801", mediaId: "m1" });
    expect(out).toMatchObject({ handled: false, reason: "disabled" });
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});

// ── location request at the delivery-address step (nlp checkout) ─────────────
describe("nlp checkout — location request", () => {
  it("choosing delivery without a saved address fires a location request", async () => {
    const session = {
      id: "s1", tenantId: "t1", waPhoneNumber: "234801", language: "english",
      state: "checkout_confirm", context: { awaitingFulfillment: true },
      messageHistory: [], cartSessionId: "cart1",
    };
    const cartItemsRows = [{ id: "ci1", cartSessionId: "cart1", productId: "p1", productName: "Rice", quantity: 1, unitPrice: "100.00", currency: "NGN" }];
    const { db } = makeQueueDb([
      [session],        // nlpSessions
      [],               // products
      [{ id: "cart1" }],// cartSessions
      cartItemsRows,    // cartItems
    ]);
    getDbMock.mockResolvedValue(db);
    vi.resetModules();
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null } as any);
    const res: any = await caller.nlp.processMessage({ tenantId: "t1", waPhoneNumber: "234801", message: "2" });
    expect(res.state).toBe("checkout_address");
    expect(res.reply).toContain("delivery address");
    expect(sendLocationReqMock).toHaveBeenCalledWith(
      "t1", "234801",
      expect.stringContaining("location"),
    );
  });
});
