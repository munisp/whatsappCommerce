/**
 * payment.initiate order-derivation tests (Wave 26 audit F1):
 * the amount/currency are derived from the SERVER-SIDE order record —
 * client-supplied values are validated, never trusted. Covers:
 *  - order not found → NOT_FOUND
 *  - cross-tenant order → FORBIDDEN
 *  - client amount ≠ order total → BAD_REQUEST
 *  - client currency ≠ order currency → BAD_REQUEST
 *  - already-paid order → CONFLICT
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./redis", () => ({ getRedis: vi.fn().mockResolvedValue(null) }));
vi.mock("./services/fraud", () => ({
  assessFraudRisk: vi.fn(() => ({ fraudProbability: 0, riskLevel: "low" })),
}));
vi.mock("./fraudCase", () => ({ createFraudCase: vi.fn() }), { virtual: false });
vi.mock("./routers/fraudCase", () => ({ createFraudCase: vi.fn() }));
vi.mock("./routers/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("./dapr", () => ({ publishPaymentEvent: vi.fn(), daprPublish: vi.fn() }));
vi.mock("./services/payments/initiateWithFallback", () => ({ initiateWithFallback: vi.fn() }));

import { getDb } from "./db";
import { paymentRouter } from "./routers/payment";

const ORDER = {
  id: "order-1",
  tenantId: "t1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "pending",
  totalAmount: "6300.00",
  currency: "NGN",
  paymentStatus: "unpaid",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeDb(order: any | null) {
  const limit = vi.fn().mockResolvedValue(order ? [order] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const db: any = { select };
  vi.mocked(getDb).mockResolvedValue(db);
  return db;
}

const TENANT_CTX = { user: { id: 2, role: "user", tenantId: "t1" } } as any;

const BASE_INPUT = {
  tenantId: "t1",
  orderId: "order-1",
  amount: 6300,
  currency: "NGN",
  provider: "paystack" as const,
  customerPhone: "2348012345678",
};

beforeEach(() => vi.clearAllMocks());

describe("payment.initiate — server-side order derivation (F1)", () => {
  it("rejects when the order does not exist", async () => {
    makeDb(null);
    const caller = paymentRouter.createCaller(TENANT_CTX);
    await expect(caller.initiate(BASE_INPUT)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a cross-tenant order", async () => {
    makeDb({ ...ORDER, tenantId: "OTHER-TENANT" });
    const caller = paymentRouter.createCaller(TENANT_CTX);
    await expect(caller.initiate(BASE_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a client amount that disagrees with the order total", async () => {
    makeDb(ORDER);
    const caller = paymentRouter.createCaller(TENANT_CTX);
    await expect(caller.initiate({ ...BASE_INPUT, amount: 100 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a client currency that disagrees with the order", async () => {
    makeDb(ORDER);
    const caller = paymentRouter.createCaller(TENANT_CTX);
    await expect(caller.initiate({ ...BASE_INPUT, currency: "USD" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects initiating payment for an already-paid order", async () => {
    makeDb({ ...ORDER, paymentStatus: "completed" });
    const caller = paymentRouter.createCaller(TENANT_CTX);
    await expect(caller.initiate(BASE_INPUT)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
