/**
 * USSD — unit tests
 * POST /ussd engine (handleUssdRequest): Africa's Talking form fields,
 * cumulative text buffer split on "*", CON/END prefixes, tenant resolution by
 * service code, and a multi-step session driving the same menu engine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendWhatsAppTextMock = vi.fn(async () => ({ sent: true, simulated: false, wamids: [], chunks: 1 }));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...args: any[]) => sendWhatsAppTextMock(...args),
  sendWhatsAppMedia: vi.fn(async () => ({ sent: true, simulated: false, wamid: null })),
}));

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

let selectQueue: any[][] = [];
const inserted: any[] = [];
const dbMock: any = {
  select: () => {
    const result = selectQueue.length > 0 ? selectQueue.shift()! : [];
    const chain: any = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(result);
    return chain;
  },
  insert: () => ({
    values: (v: any) => {
      inserted.push(v);
      return Promise.resolve();
    },
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};
vi.mock("./db", () => ({ getDb: vi.fn(async () => dbMock) }));

import { handleUssdRequest } from "./services/useCases";
import { __clearMemorySessions } from "./services/chatSession";

const TENANT = {
  id: "tenant-ussd",
  name: "Ada Stores",
  settings: {
    adminPhone: "2349000000000",
    ussd: { serviceCode: "*384*77#" },
    // All five use cases enabled (support/booking are off in the shared default).
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
const PHONE = "+2348012345678";
const BASE = { sessionId: "sess-1", serviceCode: "*384*77#", phoneNumber: PHONE };

beforeEach(() => {
  selectQueue = [];
  inserted.length = 0;
  sendWhatsAppTextMock.mockClear();
  __clearMemorySessions();
});

describe("handleUssdRequest", () => {
  it("initial dial (empty text) shows the menu with a CON prefix", async () => {
    selectQueue = [[TENANT], [], []]; // tenant by serviceCode + customers + orders
    const reply = await handleUssdRequest({ ...BASE, text: "" });
    expect(reply).toMatch(/^CON /);
    expect(reply).toContain("Welcome to Ada Stores");
    expect(reply).toContain("1. Shop / place an order");
    expect(reply).toContain("5. Talk to a human agent");
  });

  it("resolves the default template when the service code matches no tenant", async () => {
    selectQueue = [[]]; // no tenant match → tenantId "default"
    const reply = await handleUssdRequest({ sessionId: "s2", serviceCode: "*000#", phoneNumber: PHONE, text: "" });
    expect(reply).toMatch(/^CON /);
    expect(reply).toContain("1. Shop products");
  });

  it("drives a multi-step support session: CON prompts then END on completion", async () => {
    // Step 1: dial → menu (CON)
    selectQueue = [[TENANT], [], []];
    const menu = await handleUssdRequest({ ...BASE, text: "" });
    expect(menu).toMatch(/^CON /);

    // Step 2: choose "3" (support) → prompt for the issue (CON)
    selectQueue = [[TENANT]];
    const prompt = await handleUssdRequest({ ...BASE, text: "3" });
    expect(prompt).toMatch(/^CON /);
    expect(prompt).toMatch(/describe your issue/i);

    // Step 3: cumulative buffer "3*My order never arrived" → captured (END)
    selectQueue = [[TENANT]];
    const done = await handleUssdRequest({ ...BASE, text: "3*My order never arrived" });
    expect(done).toMatch(/^END /);
    expect(done).toMatch(/logged your issue/i);
    const inquiry = inserted.find((v) => v?.metadata?.type === "support_inquiry");
    expect(inquiry).toMatchObject({ fromAddress: PHONE, tenantId: TENANT.id, body: "My order never arrived" });
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      TENANT.id, "2349000000000", expect.stringContaining("My order never arrived"), expect.anything(),
    );
  });

  it("track selection returns an END reply with tracking links", async () => {
    selectQueue = [[TENANT], [], []];
    await handleUssdRequest({ ...BASE, text: "" }); // open menu session
    selectQueue = [
      [TENANT],
      [{ id: "cust-1", tenantId: TENANT.id, whatsappPhone: PHONE }],
      [{ id: "order-9", orderNumber: "ORD-009", status: "shipped", totalAmount: "2000.00", currency: "NGN" }],
    ];
    const reply = await handleUssdRequest({ ...BASE, text: "2" });
    expect(reply).toMatch(/^END /);
    expect(reply).toContain("ORD-009");
    expect(reply).toContain("/track/order-9.");
  });

  it("re-shows the menu (CON) on invalid numeric input", async () => {
    selectQueue = [[TENANT], [], []];
    await handleUssdRequest({ ...BASE, text: "" });
    selectQueue = [[TENANT], [], []]; // tenant + menu re-render selects
    const reply = await handleUssdRequest({ ...BASE, text: "99" });
    expect(reply).toMatch(/^CON /);
    expect(reply).toContain("1. Shop / place an order");
  });
});
