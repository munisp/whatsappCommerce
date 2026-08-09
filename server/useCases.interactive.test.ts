/**
 * useCases — interactive messaging tests
 * Interactive menu rendering in the WhatsApp dispatch path, menuDocUrl PDF
 * auto-push, interactive reply → resolveMenuSelection mapping, and the order
 * action card buttons (track / pay / cancel) incl. cancel ownership checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const sendWhatsAppTextMock = vi.fn(async () => ({ sent: true, simulated: false, wamids: [], chunks: 1 }));
const sendWhatsAppMediaMock = vi.fn(async () => ({ sent: true, simulated: false, wamid: "wamid.media" }));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...args: any[]) => sendWhatsAppTextMock(...args),
  sendWhatsAppMedia: (...args: any[]) => sendWhatsAppMediaMock(...args),
}));

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

const processMessageMock = vi.fn(async () => ({ reply: "What would you like to order?", intent: "browse", confidence: 1 }));
vi.mock("./routers", () => ({
  appRouter: { createCaller: () => ({ nlp: { processMessage: processMessageMock } }) },
}));

import {
  buildOrderActionCard,
  handleConversationalInbound,
  handleInteractiveInbound,
  handleOrderAction,
  orderActionReplyId,
  parseOrderActionReplyId,
} from "./services/useCases";
import { getSession, saveSession, newSession, __clearMemorySessions } from "./services/chatSession";
import { nlpSessions } from "../drizzle/schema";

// ── Chainable DB mock (with execute + update.returning) ─────────────────────
function makeDb(selectResults: any[][] = []) {
  const inserted: any[] = [];
  const updates: any[] = [];
  const executed: string[] = [];
  const db: any = {
    select: () => {
      // Shift canned rows lazily in from(): the nlpSessions checkout-step
      // probe (prod fix) must not consume a queued result.
      let result: any[] = [];
      const chain: any = {};
      chain.from = (table: any) => {
        if (table !== nlpSessions && selectResults.length > 0) result = selectResults.shift()!;
        return chain;
      };
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => Promise.resolve(result);
      chain.catch = () => Promise.resolve(result);
      return chain;
    },
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        const p: any = Promise.resolve([]);
        p.returning = () => Promise.resolve([]); // releaseReservations: no rows claimed → terminates
        return { where: () => p };
      },
    }),
    execute: (q: any) => {
      executed.push(String(q?.sql ?? q));
      return Promise.resolve({ rowCount: 1 });
    },
  };
  return { db, inserted, updates, executed };
}

const T = "tenant-1";
const P = "+2348012345678";
const TENANT = { id: T, name: "Ada Stores", settings: null as any };
const CONSENTED = [{ id: "c1", tenantId: T, phone: P, channel: "whatsapp", granted: true }];
const CUSTOMER = { id: "cust-1", tenantId: T, whatsappPhone: P, name: "Amara" };
const ORDER_PENDING = {
  id: "order-1", tenantId: T, customerId: "cust-1", orderNumber: "ORD-001",
  status: "pending", paymentStatus: "unpaid", totalAmount: "15000.00", currency: "NGN",
  createdAt: new Date("2026-08-01"),
};

beforeEach(() => {
  __clearMemorySessions();
  sendWhatsAppTextMock.mockClear();
  sendWhatsAppMediaMock.mockClear();
  processMessageMock.mockClear();
});

describe("interactive menu rendering in dispatch", () => {
  it("menu keyword → interactive buttons (≤3 entries) + text fallback reply", async () => {
    const { db } = makeDb([CONSENTED, [], []]); // consent + open-order count selects
    const out = await handleConversationalInbound({ db, tenant: TENANT, tenantId: T, phone: P, text: "menu" });
    expect(out.handled).toBe(true);
    // Default menu: 3 enabled entries → reply buttons.
    expect(out.interactive?.action.type).toBe("button");
    if (out.interactive?.action.type === "button") {
      expect(out.interactive.action.buttons.map((b) => b.id)).toEqual(["menu_1", "menu_2", "menu_3"]);
    }
    expect(out.reply).toContain("1. Shop products"); // plain-text fallback retained
    expect((await getSession(T, P))?.awaitingMenuSelection).toBe(true);
  });

  it("menu keyword → list for 4–10 entries", async () => {
    const tenant = {
      id: T, name: "Ada Stores",
      settings: {
        waMenu: {
          useCases: [
            { id: "shop", label: "Shop", enabled: true, order: 1 },
            { id: "track", label: "Track", enabled: true, order: 2 },
            { id: "support", label: "Support", enabled: true, order: 3 },
            { id: "booking", label: "Book", enabled: true, order: 4 },
            { id: "handoff", label: "Human", enabled: true, order: 5 },
          ],
        },
      },
    };
    const { db } = makeDb([CONSENTED, [], []]);
    const out = await handleConversationalInbound({ db, tenant, tenantId: T, phone: P, text: "menu" });
    expect(out.interactive?.action.type).toBe("list");
    if (out.interactive?.action.type === "list") {
      expect(out.interactive.action.sections[0].rows).toHaveLength(5);
    }
  });
});

describe("menuDocUrl PDF auto-push", () => {
  it("sends the menu PDF document when settings.menuDocUrl is set", async () => {
    const tenant = { id: T, name: "Ada Stores", settings: { menuDocUrl: "https://cdn.example.com/menu.pdf" } };
    const { db } = makeDb([CONSENTED, [], []]);
    await handleConversationalInbound({ db, tenant, tenantId: T, phone: P, text: "menu" });
    expect(sendWhatsAppMediaMock).toHaveBeenCalledWith(
      T,
      P,
      expect.objectContaining({
        type: "document",
        link: "https://cdn.example.com/menu.pdf",
        filename: "menu.pdf",
        caption: expect.stringContaining("Ada Stores"),
      }),
      expect.objectContaining({ notifType: "menu_doc" }),
    );
  });

  it("does not send media when menuDocUrl is absent or not an http URL", async () => {
    const { db } = makeDb([CONSENTED, [], []]);
    await handleConversationalInbound({ db, tenant: TENANT, tenantId: T, phone: P, text: "menu" });
    expect(sendWhatsAppMediaMock).not.toHaveBeenCalled();

    const bad = { id: T, name: "Ada Stores", settings: { menuDocUrl: "not-a-url" } };
    const { db: db2 } = makeDb([CONSENTED, [], []]);
    await handleConversationalInbound({ db: db2, tenant: bad, tenantId: T, phone: P, text: "menu" });
    expect(sendWhatsAppMediaMock).not.toHaveBeenCalled();
  });
});

describe("interactive reply → menu selection mapping", () => {
  it("button_reply id menu_2 dispatches the track use case (same as typing 2)", async () => {
    const { db } = makeDb([
      CONSENTED,      // consent gate
      [CUSTOMER],     // customers by phone
      [ORDER_PENDING],// recent orders
    ]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await handleInteractiveInbound({
      db, tenant: TENANT, tenantId: T, phone: P, replyId: "menu_2", replyTitle: "Track my order",
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("ORD-001");
    expect(out.reply).toContain(`/track/${ORDER_PENDING.id}.`);
  });

  it("list_reply resolves by title when the id is not a menu_<n> id", async () => {
    const { db } = makeDb([CONSENTED, [CUSTOMER], [ORDER_PENDING]]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await handleInteractiveInbound({
      db, tenant: TENANT, tenantId: T, phone: P, replyId: "row_abc", replyTitle: "Track my order",
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("ORD-001");
  });

  it("shop button enters the NLP flow (same as typing 1)", async () => {
    const { db } = makeDb([CONSENTED]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await handleInteractiveInbound({
      db, tenant: TENANT, tenantId: T, phone: P, replyId: "menu_1", replyTitle: "Shop products",
    });
    expect(out.handled).toBe(true);
    expect(processMessageMock).toHaveBeenCalled();
    expect((await getSession(T, P))?.mode).toBe("nlp");
  });
});

describe("order action card", () => {
  it("buildOrderActionCard → 3 buttons with order_<action>:<orderId> ids", () => {
    const card = buildOrderActionCard({ orderId: "order-1", orderNumber: "ORD-001" });
    expect(card.action.type).toBe("button");
    if (card.action.type !== "button") return;
    expect(card.bodyText).toContain("ORD-001");
    expect(card.action.buttons.map((b) => [b.id, b.title])).toEqual([
      ["order_track:order-1", "Track Order"],
      ["order_pay:order-1", "Pay Now"],
      ["order_cancel:order-1", "Cancel Order"],
    ]);
    // ids round-trip
    expect(parseOrderActionReplyId(card.action.buttons[2].id)).toEqual({ action: "cancel", orderId: "order-1" });
    expect(parseOrderActionReplyId("menu_1")).toBeNull();
    expect(orderActionReplyId("pay", "order-9")).toBe("order_pay:order-9");
  });

  it("track returns the order status + tracking link for the owner", async () => {
    const { db } = makeDb([
      [ORDER_PENDING], // order by id
      [CUSTOMER],      // ownership: customer by phone
      [],              // shipments
    ]);
    const reply = await handleOrderAction({ db, tenantId: T, phone: P, action: "track", orderId: "order-1" });
    expect(reply).toContain("ORD-001");
    expect(reply).toContain(`/track/order-1.`);
  });

  it("pay resends the payment link for the owner's unpaid order", async () => {
    const { db } = makeDb([
      [ORDER_PENDING],
      [CUSTOMER],
      [{ paymentUrl: "https://pay.example/abc123" }], // latest payment transaction
    ]);
    const reply = await handleOrderAction({ db, tenantId: T, phone: P, action: "pay", orderId: "order-1" });
    expect(reply).toContain("https://pay.example/abc123");
    expect(reply).toContain("ORD-001");
  });

  it("pay short-circuits when the order is already paid", async () => {
    const paid = { ...ORDER_PENDING, paymentStatus: "completed" };
    const { db } = makeDb([[paid], [CUSTOMER]]);
    const reply = await handleOrderAction({ db, tenantId: T, phone: P, action: "pay", orderId: "order-1" });
    expect(reply).toMatch(/already paid/i);
  });

  it("cancel refuses an order owned by a different phone", async () => {
    const foreign = { ...ORDER_PENDING, customerId: "cust-2" };
    const { db, updates } = makeDb([
      [foreign],   // order row
      [CUSTOMER],  // caller's customer row — id cust-1 ≠ cust-2
    ]);
    const reply = await handleOrderAction({ db, tenantId: T, phone: P, action: "cancel", orderId: "order-1" });
    expect(reply).toMatch(/couldn't find that order/i);
    expect(updates).toHaveLength(0); // no status mutation
  });

  it("cancel refuses a non-pending order", async () => {
    const shipped = { ...ORDER_PENDING, status: "shipped" };
    const { db, updates } = makeDb([[shipped], [CUSTOMER]]);
    const reply = await handleOrderAction({ db, tenantId: T, phone: P, action: "cancel", orderId: "order-1" });
    expect(reply).toMatch(/can no longer be cancelled/i);
    expect(updates).toHaveLength(0);
  });

  it("cancel marks the owner's pending order cancelled and releases stock", async () => {
    const { db, updates, executed } = makeDb([
      [ORDER_PENDING],  // order by id
      [CUSTOMER],       // ownership
      [{ productId: "prod-1", quantity: 2 }], // orderItems
    ]);
    const reply = await handleOrderAction({ db, tenantId: T, phone: P, action: "cancel", orderId: "order-1" });
    expect(reply).toMatch(/has been cancelled/i);
    expect(updates.some((u) => u.status === "cancelled")).toBe(true);
    expect(executed.length).toBeGreaterThan(0); // inventory_snapshots release ran
  });

  it("interactive order_cancel reply routes through handleInteractiveInbound", async () => {
    const { db, updates } = makeDb([
      [ORDER_PENDING],
      [CUSTOMER],
      [], // orderItems
    ]);
    const out = await handleInteractiveInbound({
      db, tenant: TENANT, tenantId: T, phone: P, replyId: "order_cancel:order-1", replyTitle: "Cancel Order",
    });
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/has been cancelled/i);
    expect(updates.some((u) => u.status === "cancelled")).toBe(true);
  });
});
