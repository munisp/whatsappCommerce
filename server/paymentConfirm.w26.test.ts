/**
 * paymentConfirm Wave 26 (F1b) tests:
 *  - webhook amount comparison is EXACT in integer minor units (₦0.01 off is
 *    now REJECTED — the old tolerance accepted it)
 *  - the order-confirmation UPDATE is scoped by tenantId
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("./services/integrations/outbox", () => ({ syncLocalChange: vi.fn() }));
vi.mock("./routers/escrow", () => ({ creditWalletTopUp: vi.fn().mockResolvedValue({ credited: false, reason: "not-topup" }) }));
vi.mock("./routers/invoice", () => ({ markInvoicePaidFromPaymentIntent: vi.fn().mockResolvedValue({ paid: false }) }));
vi.mock("./services/inventory", () => ({ commitReservations: vi.fn().mockResolvedValue(0) }));
vi.mock("./services/observability", () => ({ captureException: vi.fn() }));
vi.mock("./services/receipts", () => ({ sendOrderReceipt: vi.fn().mockResolvedValue({ sent: true }) }));

import { confirmProviderPayment } from "./services/paymentConfirm";

const INTENT = {
  id: "pi-1",
  tenantId: "t1",
  orderId: "order-1",
  customerId: "cust-1",
  providerPaymentId: "PAY-REF-1",
  provider: "paystack",
  amount: "6300.00",
  currency: "NGN",
  status: "initiated",
  metadata: {},
};

function makeDb(opts: { intent?: any; orderRow?: any; existingEscrow?: any } = {}) {
  const { intent = INTENT, orderRow = { id: "order-1" }, existingEscrow = { id: "esc-1" } } = opts;
  const whereConds: Record<string, any[]> = {};
  const rowsByTable: Record<string, any[]> = {
    payment_transactions: [],
    payment_intents: intent ? [intent] : [],
    orders: orderRow ? [orderRow] : [],
    escrow_transactions: existingEscrow ? [existingEscrow] : [],
  };
  const select = vi.fn(() => ({
    from: vi.fn((table: any) => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rowsByTable[getTableName(table)] ?? [])),
      })),
    })),
  }));
  const update = vi.fn((table: any) => ({
    set: vi.fn(() => ({
      where: vi.fn((cond: any) => {
        const name = getTableName(table);
        (whereConds[name] ??= []).push(cond);
        const self: any = {
          returning: vi.fn(() => Promise.resolve([{ id: "pi-1" }])),
          then: (res: (v: any) => void) => { res(undefined); return self; },
          catch: () => self,
        };
        return self;
      }),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) })),
  }));
  return { select, update, insert, whereConds } as any;
}

const BASE = {
  provider: "paystack",
  reference: "PAY-REF-1",
  currency: "NGN",
  rawPayload: {},
};

beforeEach(() => vi.clearAllMocks());

describe("confirmProviderPayment — exact minor-unit amount match (F1b)", () => {
  it("rejects a webhook amount even ₦0.01 off the expected amount", async () => {
    const db = makeDb();
    const r = await confirmProviderPayment(db, { ...BASE, amountMajor: 6300.01 });
    expect(r.ok).toBe(false);
    expect(r.action).toBe("amount-currency-mismatch");
  });

  it("accepts an exactly matching amount", async () => {
    const db = makeDb();
    const r = await confirmProviderPayment(db, { ...BASE, amountMajor: 6300.0 });
    expect(r.ok).toBe(true);
  });

  it("scopes the order-confirmation UPDATE by tenantId", async () => {
    const db = makeDb();
    const r = await confirmProviderPayment(db, { ...BASE, amountMajor: 6300.0 });
    expect(r.ok).toBe(true);
    const conds = db.whereConds["orders"] ?? [];
    expect(conds.length).toBeGreaterThan(0);
    const dialect = new PgDialect();
    const sqlText = conds.map((c: any) => dialect.sqlToQuery(c).sql).join(" ; ");
    expect(sqlText).toContain("tenantId");
  });

  it("does not confirm an order belonging to a different tenant", async () => {
    // The tenant-scoped order lookup misses → orderId nulled → no orders UPDATE.
    const db = makeDb({ orderRow: null });
    const r = await confirmProviderPayment(db, { ...BASE, amountMajor: 6300.0 });
    expect(r.ok).toBe(true);
    expect(db.whereConds["orders"] ?? []).toHaveLength(0);
  });
});
