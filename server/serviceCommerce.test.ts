/**
 * serviceCommerce value-grant tests (Wave 26 audit F3):
 *  - purchaseDigitalProduct without a verified payment → PRECONDITION_FAILED
 *  - purchaseDigitalProduct with a confirmed, tenant-matching, exact-amount
 *    payment record → grant issued
 *  - purchaseDigitalProduct with a payment from ANOTHER tenant → rejected
 *  - createSubscription without a verified payment → PRECONDITION_FAILED
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));

import { getDb } from "./db";
import { serviceCommerceRouter } from "./routers/serviceCommerce";
import { getTableName } from "drizzle-orm";

const PRODUCT = {
  id: "prod-1",
  tenantId: "t1",
  name: "E-book",
  price: "2500.00",
  currency: "NGN",
  isActive: true,
};

/**
 * Fake db routing select queries by table name. `rowsByTable` maps a drizzle
 * table's name to the rows its select should return.
 */
function makeDb(rowsByTable: Record<string, any[]>) {
  const inserted: any[] = [];
  const select = vi.fn(() => ({
    from: vi.fn((table: any) => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rowsByTable[getTableName(table)] ?? [])),
        orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rowsByTable[getTableName(table)] ?? [])) })),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((v: any) => {
      inserted.push(v);
      return Promise.resolve([]);
    }),
  }));
  const db: any = { select, insert };
  vi.mocked(getDb).mockResolvedValue(db);
  return { db, inserted };
}

const ANON = { user: null } as any;

const PURCHASE_INPUT = {
  productId: "prod-1",
  tenantId: "t1",
  customerPhone: "2348012345678",
  paymentReference: "PAY-REF-1",
};

beforeEach(() => vi.clearAllMocks());

describe("purchaseDigitalProduct — verified payment required (F3)", () => {
  it("rejects when no payment record exists for the reference", async () => {
    makeDb({ digital_products: [PRODUCT], payment_intents: [], payment_transactions: [] });
    const caller = serviceCommerceRouter.createCaller(ANON);
    await expect(caller.purchaseDigitalProduct(PURCHASE_INPUT))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects a payment reference belonging to another tenant", async () => {
    // Tenant-scoped lookup means the other tenant's intent is invisible.
    makeDb({ digital_products: [PRODUCT], payment_intents: [], payment_transactions: [] });
    const caller = serviceCommerceRouter.createCaller(ANON);
    await expect(
      caller.purchaseDigitalProduct({ ...PURCHASE_INPUT, paymentReference: "OTHER-TENANT-REF" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects a confirmed payment whose amount does not match the price", async () => {
    makeDb({
      digital_products: [PRODUCT],
      payment_intents: [{
        id: "pi-1", tenantId: "t1", providerPaymentId: "PAY-REF-1",
        status: "completed", amount: "100.00", currency: "NGN", metadata: {},
      }],
    });
    const caller = serviceCommerceRouter.createCaller(ANON);
    await expect(caller.purchaseDigitalProduct(PURCHASE_INPUT))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("grants a download token with a confirmed, exact-amount payment", async () => {
    const { inserted } = makeDb({
      digital_products: [PRODUCT],
      payment_intents: [{
        id: "pi-1", tenantId: "t1", providerPaymentId: "PAY-REF-1",
        status: "completed", amount: "2500.00", currency: "NGN", metadata: {},
      }],
    });
    const caller = serviceCommerceRouter.createCaller(ANON);
    const r = await caller.purchaseDigitalProduct(PURCHASE_INPUT);
    expect(r.downloadToken).toBeTruthy();
    expect(inserted).toHaveLength(1);
  });
});

describe("createSubscription — verified payment required (F3)", () => {
  const SUB_INPUT = {
    serviceId: "svc-1",
    tenantId: "t1",
    customerPhone: "2348012345678",
    amount: "5000.00",
    paymentReference: "PAY-REF-9",
  };

  it("rejects without a verified payment", async () => {
    makeDb({ payment_intents: [], payment_transactions: [] });
    const caller = serviceCommerceRouter.createCaller(ANON);
    await expect(caller.createSubscription(SUB_INPUT))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("activates with a confirmed, exact-amount payment", async () => {
    const { inserted } = makeDb({
      payment_intents: [{
        id: "pi-9", tenantId: "t1", providerPaymentId: "PAY-REF-9",
        status: "completed", amount: "5000.00", currency: "NGN", metadata: {},
      }],
    });
    const caller = serviceCommerceRouter.createCaller(ANON);
    const r = await caller.createSubscription(SUB_INPUT);
    expect(r.status).toBe("active");
    expect(inserted).toHaveLength(1);
  });
});
