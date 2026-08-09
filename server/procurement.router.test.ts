/**
 * procurement router tests — tenant scoping + authZ:
 *  - supplier profile CRUD restricted to own tenant
 *  - PO list/detail tenant isolation (buyer A ≁ buyer B; supplier sees own side)
 *  - approve/reject/fulfil are supplier-side only (supplier C ≁ supplier D)
 *  - cancel-draft is buyer-only
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendTextMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
const sendInteractiveMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...a: any[]) => sendTextMock(...a),
  sendWhatsAppInteractive: (...a: any[]) => sendInteractiveMock(...a),
  sendWhatsAppMedia: vi.fn(async () => ({ sent: true })),
}));

const credit = vi.hoisted(() => ({
  getCreditAccount: vi.fn(async () => null as any),
  drawOnCredit: vi.fn(async () => ({ ok: true as const, ledgerId: "led-1", outstandingAfter: 50_000 })),
  suggestLimit: vi.fn(async () => ({ score: 1, suggestedLimitCents: 1, reasons: [] as string[] })),
}));
vi.mock("./services/tradeCredit", () => credit);

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => dbHolder.db) };
});

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { makeFakeDb, seedPo, seedSupplierProfile } from "./services/procurement/fakeDb";

function makeCtx(role: "admin" | "user", tenantId?: string): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "t@e.c",
      name: "T",
      loginMethod: "manus",
      role,
      tenantId: tenantId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any,
    req: {} as any,
    res: {} as any,
  } as TrpcContext;
}

const TENANTS = [
  { id: "buyer-1", name: "Buyer One", settings: null },
  { id: "buyer-2", name: "Buyer Two", settings: null },
  { id: "supplier-1", name: "Ada Wholesale", settings: { adminPhone: "+2348000000010" } },
  { id: "supplier-2", name: "Chidi Foods", settings: null },
];

let store: ReturnType<typeof makeFakeDb>["store"];

beforeEach(() => {
  vi.clearAllMocks();
  credit.drawOnCredit.mockResolvedValue({ ok: true, ledgerId: "led-1", outstandingAfter: 50_000 });
  const fake = makeFakeDb({
    tenants: TENANTS.map((t) => ({ ...t })),
    supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1" })],
    purchaseOrders: [
      seedPo({ id: "po-b1", poNumber: "PO-20250101-AAAA", buyerTenantId: "buyer-1", supplierTenantId: "supplier-1" }),
      seedPo({ id: "po-b2", poNumber: "PO-20250101-BBBB", buyerTenantId: "buyer-2", supplierTenantId: "supplier-1" }),
      seedPo({ id: "po-s2", poNumber: "PO-20250101-CCCC", buyerTenantId: "buyer-1", supplierTenantId: "supplier-2" }),
    ],
    poItems: [{ id: "i1", poId: "po-b1", productRef: "p1", name: "Rice", qty: 2, unitPriceCents: 25_000, lineTotalCents: 50_000 }],
  });
  dbHolder.db = fake.db;
  store = fake.store;
});

describe("supplier profile CRUD auth", () => {
  it("a tenant can create + read its own supplier profile", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "supplier-1"));
    const profile = await caller.procurement.upsertSupplierProfile({ tenantId: "supplier-1", moqCents: 5_000, categories: ["oil"] });
    expect(profile.moqCents).toBe(5_000);
    const fetched = await caller.procurement.getMySupplierProfile({ tenantId: "supplier-1" });
    expect(fetched?.categories).toEqual(["oil"]);
  });

  it("a tenant CANNOT write another tenant's supplier profile", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "buyer-1"));
    await expect(
      caller.procurement.upsertSupplierProfile({ tenantId: "supplier-1", moqCents: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.procurement.getMySupplierProfile({ tenantId: "supplier-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("PO list/detail tenant isolation", () => {
  it("buyer A sees only their own POs; supplier role scoping works", async () => {
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    const mine = await buyer1.procurement.listPos({ tenantId: "buyer-1", role: "buyer" });
    expect(mine.map((p) => p.id).sort()).toEqual(["po-b1", "po-s2"]);
    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    const incoming = await supplier1.procurement.listPos({ tenantId: "supplier-1", role: "supplier", status: "submitted" });
    expect(incoming.map((p) => p.id).sort()).toEqual(["po-b1", "po-b2"]);
    const asBuyer = await supplier1.procurement.listPos({ tenantId: "supplier-1", role: "buyer" });
    expect(asBuyer).toHaveLength(0);
  });

  it("buyer A cannot read buyer B's PO; both sides of a PO can read it", async () => {
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    await expect(buyer1.procurement.getPo({ poId: "po-b2" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const detail = await buyer1.procurement.getPo({ poId: "po-b1" });
    expect(detail.items).toHaveLength(1);
    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    expect((await supplier1.procurement.getPo({ poId: "po-b1" })).po.id).toBe("po-b1");
    const supplier2 = appRouter.createCaller(makeCtx("user", "supplier-2"));
    await expect(supplier2.procurement.getPo({ poId: "po-b1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("approve/reject auth", () => {
  it("only the SUPPLIER tenant can approve (supplier C ≁ supplier D, buyer ≁ supplier)", async () => {
    const supplier2 = appRouter.createCaller(makeCtx("user", "supplier-2"));
    await expect(supplier2.procurement.approvePo({ poId: "po-b1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    await expect(buyer1.procurement.approvePo({ poId: "po-b1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    const result = await supplier1.procurement.approvePo({ poId: "po-b1" });
    expect(result.approved).toBe(true);
    expect(store.purchaseOrders.find((p) => p.id === "po-b1")?.status).toBe("invoiced");
  });

  it("only the supplier tenant can reject; credit guard failure surfaces as creditFailure", async () => {
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    await expect(buyer1.procurement.rejectPo({ poId: "po-b1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    credit.drawOnCredit.mockResolvedValue({ ok: false, reason: "over_limit" } as any);
    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    const failed = await supplier1.procurement.approvePo({ poId: "po-b2" });
    expect(failed).toEqual({ approved: false, creditFailure: "over_limit" });
    const rejected = await supplier1.procurement.rejectPo({ poId: "po-b2", reason: "no stock" });
    expect(rejected.rejected).toBe(true);
    expect(store.purchaseOrders.find((p) => p.id === "po-b2")?.status).toBe("rejected");
  });

  it("approving a non-submitted PO is a CONFLICT", async () => {
    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    await supplier1.procurement.approvePo({ poId: "po-b1" });
    await expect(supplier1.procurement.approvePo({ poId: "po-b1" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("cancel draft (buyer only)", () => {
  it("buyer can cancel their own draft; drafts only; own tenant only", async () => {
    store.purchaseOrders.push(seedPo({ id: "po-draft", poNumber: "PO-20250101-DDDD", status: "draft", buyerTenantId: "buyer-1" }));
    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    await expect(
      supplier1.procurement.cancelDraftPo({ poId: "po-draft", buyerTenantId: "buyer-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" }); // not the buyer tenant
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    expect((await buyer1.procurement.cancelDraftPo({ poId: "po-draft", buyerTenantId: "buyer-1" })).cancelled).toBe(true);
    expect(store.purchaseOrders.find((p) => p.id === "po-draft")).toBeUndefined();
    await expect(
      buyer1.procurement.cancelDraftPo({ poId: "po-s2", buyerTenantId: "buyer-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" }); // submitted, not draft
  });
});

describe("create + fulfill + markPaid via router", () => {
  it("createPo submits and returns the PO; markFulfilled + markPaid are supplier-side", async () => {
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    const created = await buyer1.procurement.createPo({
      buyerTenantId: "buyer-1",
      supplierTenantId: "supplier-1",
      paymentMode: "paynow",
      lines: [{ name: "Rice 50kg", qty: 1, unitPriceCents: 40_000 }],
    });
    expect(created.po?.status).toBe("submitted");
    expect(sendInteractiveMock).toHaveBeenCalled(); // supplier action card

    const supplier1 = appRouter.createCaller(makeCtx("user", "supplier-1"));
    store.purchaseOrders.push(seedPo({ id: "po-pay", poNumber: "PO-20250101-EEEE", status: "approved", paymentMode: "paynow", buyerTenantId: "buyer-1" }));
    expect((await supplier1.procurement.markPaid({ poId: "po-pay", reference: "ref-9" })).paid).toBe(true);
    expect((await supplier1.procurement.markFulfilled({ poId: "po-pay" })).fulfilled).toBe(true);
    const buyer2 = appRouter.createCaller(makeCtx("user", "buyer-2"));
    await expect(buyer2.procurement.markFulfilled({ poId: "po-pay" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("createPo enforces MOQ with a BAD_REQUEST", async () => {
    store.supplierProfiles[0].moqCents = 1_000_000;
    const buyer1 = appRouter.createCaller(makeCtx("user", "buyer-1"));
    await expect(
      buyer1.procurement.createPo({
        buyerTenantId: "buyer-1", supplierTenantId: "supplier-1",
        lines: [{ name: "Rice", qty: 1, unitPriceCents: 100 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("unauthenticated callers are rejected", async () => {
    const caller = appRouter.createCaller({ ...makeCtx("user", "buyer-1"), user: null });
    await expect(caller.procurement.listPos({ tenantId: "buyer-1", role: "buyer" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
