/**
 * useCases — unit tests
 * Use-case dispatch through the conversational orchestrator: consent gate,
 * menu keywords, numeric selection, track with mocked orders, support intake,
 * booking slot-filling, handoff, custom items, fallback modes, and the
 * emoji-reaction → order status reply. All outbound via mocked waSender.
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
  handleConversationalInbound,
  handleReactionInbound,
  countOpenOrders,
} from "./services/useCases";
import { getSession, saveSession, newSession, __clearMemorySessions } from "./services/chatSession";
import { nlpSessions } from "../drizzle/schema";

// ── Chainable DB mock ────────────────────────────────────────────────────────
function makeDb(selectResults: any[][] = []) {
  const inserted: Array<{ table: any; values: any }> = [];
  const updates: Array<any> = [];
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
      return chain;
    },
    insert: (table: any) => ({
      values: (v: any) => {
        inserted.push({ table, values: v });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { db, inserted, updates };
}

const T = "tenant-1";
const P = "+2348012345678";
const CONSENTED = [{ id: "c1", tenantId: T, phone: P, channel: "whatsapp", granted: true }];

const ORDER_1 = {
  id: "order-1", tenantId: T, customerId: "cust-1", orderNumber: "ORD-001",
  status: "shipped", totalAmount: "15000.00", currency: "NGN", createdAt: new Date("2026-08-01"),
};
const ORDER_2 = {
  id: "order-2", tenantId: T, customerId: "cust-1", orderNumber: "ORD-002",
  status: "delivered", totalAmount: "4500.00", currency: "NGN", createdAt: new Date("2026-07-20"),
};
const CUSTOMER = { id: "cust-1", tenantId: T, whatsappPhone: P, name: "Amara" };

function call(db: any, text: string, tenant: any = { id: T, name: "Ada Stores", settings: null }) {
  return handleConversationalInbound({ db, tenant, tenantId: T, phone: P, text, customerName: "Amara" });
}

/** Tenant with ALL five use cases enabled (support/booking are off in the shared default). */
const FULL_MENU_TENANT = {
  id: T,
  name: "Ada Stores",
  settings: {
    waMenu: {
      useCases: [
        { id: "shop", label: "Shop / place an order", enabled: true, order: 1 },
        { id: "track", label: "Track my order", enabled: true, order: 2 },
        { id: "support", label: "Customer support", enabled: true, order: 3 },
        { id: "booking", label: "Book an appointment", enabled: true, order: 4 },
        { id: "handoff", label: "Talk to a human agent", enabled: true, order: 5 },
      ],
    },
  },
};

beforeEach(() => {
  __clearMemorySessions();
  sendWhatsAppTextMock.mockClear();
  processMessageMock.mockClear();
});

describe("consent gate (first-ever inbound)", () => {
  it("prompts for NDPR opt-in when no consents row exists", async () => {
    const { db } = makeDb([[]]); // no consent row
    const out = await call(db, "hi");
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/Reply YES to receive order updates/i);
    expect((await getSession(T, P))?.awaitingConsent).toBe(true);
  });

  it("persists YES to consents (channel whatsapp) and shows the menu", async () => {
    const { db, inserted } = makeDb([
      [], // getConsent → none
      [], // countOpenOrders: customers
      [], // countOpenOrders: orders
    ]);
    await saveSession({ ...newSession(T, P), awaitingConsent: true });
    const out = await call(db, "YES");
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/opted in/i);
    expect(out.reply).toContain("1. Shop products");
    const consentInsert = inserted.find((i) => i.values?.channel === "whatsapp");
    expect(consentInsert?.values).toMatchObject({ tenantId: T, phone: P, granted: true });
  });

  it("persists NO and acknowledges the opt-out", async () => {
    const { db, inserted } = makeDb([[]]);
    await saveSession({ ...newSession(T, P), awaitingConsent: true });
    const out = await call(db, "NO");
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/opted out/i);
    expect(inserted[0]?.values).toMatchObject({ granted: false, channel: "whatsapp" });
    expect(await getSession(T, P)).toBeNull();
  });

  it("re-prompts when the reply is not YES/NO", async () => {
    const { db } = makeDb([[]]);
    await saveSession({ ...newSession(T, P), awaitingConsent: true });
    const out = await call(db, "what is this?");
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/Reply YES/i);
  });
});

describe("menu dispatch", () => {
  it("shows the menu on a greeting keyword", async () => {
    const { db } = makeDb([
      CONSENTED, // consent
      [],        // customers (open-order count)
      [],        // orders
    ]);
    const out = await call(db, "menu");
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("Welcome to Ada Stores");
    expect(out.reply).toContain("3. Talk to a human");
    expect((await getSession(T, P))?.awaitingMenuSelection).toBe(true);
  });

  it("falls back to the NLP pipeline for unknown free text (default fallback)", async () => {
    const { db } = makeDb([CONSENTED]);
    const out = await call(db, "do you have fresh bread?");
    expect(out.handled).toBe(false);
  });

  it("re-shows the menu for unknown input when fallback = menu", async () => {
    const { db } = makeDb([CONSENTED, [], []]);
    const tenant = { id: T, name: "Ada Stores", settings: { waMenu: { fallback: "menu" } } };
    const out = await call(db, "asdfgh", tenant);
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("1. Shop products");
  });

  it("returns a custom item response for its number", async () => {
    const tenant = {
      id: T, name: "Ada Stores",
      settings: {
        waMenu: {
          useCases: [{ id: "shop", label: "Shop", enabled: true, order: 1 }],
          customItems: [{ key: "hours", label: "Opening hours", response: "We are open 9am-5pm WAT." }],
        },
      },
    };
    const { db } = makeDb([CONSENTED, [], []]); // consent + menu render selects
    await call(db, "hi", tenant); // show menu (default merged config has 1 use case + 1 custom)
    const { db: db2 } = makeDb([CONSENTED]);
    const out = await call(db2, "2", tenant);
    expect(out.handled).toBe(true);
    expect(out.reply).toBe("We are open 9am-5pm WAT.");
  });
});

describe("track use case (mocked orders)", () => {
  it("lists recent orders with status and /track/:token links", async () => {
    const { db } = makeDb([
      CONSENTED,          // consent
      [CUSTOMER],         // customers by phone
      [ORDER_1, ORDER_2], // recent orders
    ]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await call(db, "2");
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("ORD-001");
    expect(out.reply).toContain("shipped");
    expect(out.reply).toContain("ORD-002");
    expect(out.reply).toContain(`/track/${ORDER_1.id}.`);
    // terminal → session cleared
    expect(await getSession(T, P)).toBeNull();
  });

  it("tells the caller when no orders exist", async () => {
    const { db } = makeDb([CONSENTED, [], []]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await call(db, "2");
    expect(out.reply).toMatch(/couldn't find any orders/i);
  });

  it("countOpenOrders counts only non-terminal orders", async () => {
    const { db } = makeDb([[CUSTOMER], [ORDER_1, ORDER_2]]);
    expect(await countOpenOrders(db, T, P)).toBe(1); // ORD-002 delivered → closed
  });
});

describe("shop use case → NLP flow", () => {
  it("enters the NLP ordering pipeline and pins the session to nlp mode", async () => {
    const { db } = makeDb([CONSENTED]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await call(db, "1");
    expect(out.handled).toBe(true);
    expect(out.reply).toBe("What would you like to order?");
    expect(processMessageMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, waPhoneNumber: P }));
    expect((await getSession(T, P))?.mode).toBe("nlp");
  });

  it("routes follow-up messages to the NLP pipeline (handled=false)", async () => {
    const { db } = makeDb([CONSENTED]);
    await saveSession({ ...newSession(T, P), mode: "nlp" });
    const out = await call(db, "2 bags of rice please");
    expect(out.handled).toBe(false);
  });
});

describe("support use case", () => {
  it("captures the issue and notifies the tenant admin via waSender", async () => {
    const tenant = { id: T, name: "Ada Stores", settings: { adminPhone: "2349000000000" } };
    const { db, inserted } = makeDb([CONSENTED]);
    await saveSession({ ...newSession(T, P), mode: "usecase", activeUseCase: "support", step: "awaiting_issue", data: {} });
    const out = await call(db, "My order never arrived", tenant);
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/logged your issue/i);
    const inquiry = inserted.find((i) => i.values?.metadata?.type === "support_inquiry");
    expect(inquiry?.values).toMatchObject({ fromAddress: P, tenantId: T, body: "My order never arrived" });
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      T, "2349000000000", expect.stringContaining("My order never arrived"), expect.anything(),
    );
    expect(await getSession(T, P)).toBeNull();
  });

  it("asks for the issue first when the flow starts", async () => {
    const { db } = makeDb([CONSENTED]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await call(db, "3", FULL_MENU_TENANT);
    expect(out.reply).toMatch(/describe your issue/i);
    const s = await getSession(T, P);
    expect(s?.activeUseCase).toBe("support");
    expect(s?.step).toBe("awaiting_issue");
  });
});

describe("booking use case (slot filling)", () => {
  const SERVICE = { id: "svc-1", tenantId: T, name: "Braids", price: "5000", currency: "NGN", isActive: true };

  it("collects service then datetime, creates an appointment, notifies admin", async () => {
    // Step 1: select "booking" from the menu → list services
    const { db: db1 } = makeDb([CONSENTED, [SERVICE]]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out1 = await call(db1, "4", FULL_MENU_TENANT);
    expect(out1.reply).toContain("1. Braids — 5000 NGN");
    expect((await getSession(T, P))?.step).toBe("choose_service");

    // Step 2: pick the service → ask for date/time
    const { db: db2 } = makeDb([CONSENTED]);
    const out2 = await call(db2, "1");
    expect(out2.reply).toMatch(/date and time/i);
    expect((await getSession(T, P))?.step).toBe("choose_datetime");

    // Step 3: supply a datetime → appointment created
    const tenant = { id: T, name: "Ada Stores", settings: { adminPhone: "2349000000000" } };
    const { db: db3, inserted } = makeDb([CONSENTED]);
    const out3 = await call(db3, "2027-01-15 10:00", tenant);
    expect(out3.reply).toMatch(/Booked!/);
    const appt = inserted.find((i) => i.values?.serviceId === "svc-1");
    expect(appt?.values).toMatchObject({ tenantId: T, customerPhone: P, status: "scheduled" });
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(T, "2349000000000", expect.stringContaining("Braids"), expect.anything());
    expect(await getSession(T, P)).toBeNull();
  });

  it("rejects an unparseable/past datetime and re-asks", async () => {
    const { db } = makeDb([CONSENTED]);
    await saveSession({
      ...newSession(T, P), mode: "usecase", activeUseCase: "booking", step: "choose_datetime",
      data: { serviceId: "svc-1", serviceName: "Braids" },
    });
    const out = await call(db, "next week maybe");
    expect(out.reply).toMatch(/couldn't understand/i);
    expect((await getSession(T, P))?.step).toBe("choose_datetime");
  });

  it("ends gracefully when the tenant has no bookable services", async () => {
    const { db } = makeDb([CONSENTED, []]); // consent + empty service catalog
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const out = await call(db, "4", FULL_MENU_TENANT);
    expect(out.reply).toMatch(/bookable services/i);
    expect(await getSession(T, P)).toBeNull();
  });
});

describe("handoff use case", () => {
  it("flags the open conversation and notifies the admin", async () => {
    const tenant = { id: T, name: "Ada Stores", settings: { adminPhone: "2349000000000" } };
    const CONV = { id: "conv-1", tenantId: T, customerId: "cust-1", status: "open", metadata: { foo: 1 } };
    const { db, updates } = makeDb([CONSENTED, [CUSTOMER], [CONV]]);
    await saveSession({ ...newSession(T, P), awaitingMenuSelection: true });
    const fullMenuWithAdmin = {
      ...FULL_MENU_TENANT,
      settings: { ...FULL_MENU_TENANT.settings, adminPhone: "2349000000000" },
    };
    const out = await call(db, "5", fullMenuWithAdmin);
    expect(out.reply).toMatch(/human agent/i);
    expect(updates[0]).toMatchObject({ aiHandled: false, status: "pending" });
    expect(updates[0].metadata).toMatchObject({ foo: 1, handoffRequested: true });
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(T, "2349000000000", expect.stringContaining(P), expect.anything());
  });
});

describe("emoji-reaction → order status reply", () => {
  it("replies with latest order/shipment status + tracking link", async () => {
    const { db } = makeDb([
      [CUSTOMER],                       // customers by phone
      [ORDER_1],                        // latest order
      [{ status: "in_transit" }],       // latest shipment
    ]);
    const reply = await handleReactionInbound({ db, tenantId: T, phone: P });
    expect(reply).toContain("ORD-001");
    expect(reply).toContain("in_transit");
    expect(reply).toContain(`/track/${ORDER_1.id}.`);
  });

  it("returns null when the sender has no orders", async () => {
    const { db } = makeDb([[], []]);
    expect(await handleReactionInbound({ db, tenantId: T, phone: P })).toBeNull();
  });
});
