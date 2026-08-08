/**
 * chatDispute — unit tests
 * Chat dispute self-service: escrow-backed orders go through the SHARED
 * raiseEscrowDispute path (guarded state transition + dispute row + merchant
 * notification), non-escrow complaints fall back to a merchant notification,
 * the admin phone is always notified, and cross-tenant orders are invisible.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const emitNotificationMock = vi.fn(async () => ({}));
vi.mock("./routers/notifications", () => ({
  emitNotification: (...args: any[]) => emitNotificationMock(...args),
}));

// ── In-memory DB mock with real condition filtering ──────────────────────────

const stores: Record<string, Record<string, unknown>[]> = {};
const dialect = new PgDialect();

function filterRows(table: unknown, cond: unknown, rows: Record<string, unknown>[]) {
  if (!cond) return rows;
  let compiled: { sql: string; params: unknown[] };
  try {
    compiled = dialect.sqlToQuery(cond as never);
  } catch {
    return rows;
  }
  const colMap: Record<string, string> = {};
  try {
    for (const [prop, col] of Object.entries(getTableColumns(table as never))) {
      colMap[(col as { name: string }).name] = prop;
    }
  } catch {
    return rows;
  }
  const tests: Array<(r: Record<string, unknown>) => boolean> = [];
  for (const part of compiled.sql.split(/ and /)) {
    const mEq = part.match(/"[\w]+"\."([\w]+)" = \$(\d+)/);
    if (mEq) {
      const prop = colMap[mEq[1]];
      const val = compiled.params[Number(mEq[2]) - 1];
      if (prop) tests.push((r) => String(r[prop]) === String(val));
      continue;
    }
    const mIn = part.match(/"[\w]+"\."([\w]+)" in \(([^)]*)\)/i);
    if (mIn) {
      const prop = colMap[mIn[1]];
      const vals = mIn[2].split(",").map((s) => compiled.params[Number(s.trim().slice(1)) - 1]);
      if (prop) tests.push((r) => vals.some((v) => String(r[prop]) === String(v)));
    }
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

function makeChain(rows: Record<string, unknown>[]): any {
  const self: any = {};
  const chain = () => makeChain(rows);
  self.orderBy = chain;
  self.limit = chain;
  self.returning = () => Promise.resolve(rows);
  self.then = (resolve: (v: unknown) => void) => {
    resolve(rows);
    return self;
  };
  self.catch = () => self;
  return self;
}

const db: any = {
  select: () => ({
    from: (table: unknown) => {
      const all = stores[getTableName(table as never)] ?? [];
      const api: any = {};
      api.where = (cond: unknown) => makeChain(filterRows(table, cond, all));
      api.then = (resolve: (v: unknown) => void) => {
        resolve(all);
        return api;
      };
      return api;
    },
  }),
  insert: (table: unknown) => ({
    values: (vals: Record<string, unknown>) => {
      const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...vals };
      (stores[getTableName(table as never)] ??= []).push(row);
      return {
        returning: () => Promise.resolve([row]),
        then: (resolve: (v: unknown) => void) => resolve([row]),
        onConflictDoNothing: () => Promise.resolve(),
      };
    },
  }),
  update: (table: unknown) => ({
    set: (vals: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        const name = getTableName(table as never);
        const matched = filterRows(table, cond, stores[name] ?? []);
        for (const row of matched) Object.assign(row, vals);
        return {
          returning: () => Promise.resolve(matched),
          then: (resolve: (v: unknown) => void) => resolve(matched),
        };
      },
    }),
  }),
};

import { raiseChatDispute, buildDisputeReply, classifyDisputeReason } from "./services/chatDispute";

const T = "tenant-1";
const PHONE = "2348000000001";
const ADMIN = "2349000000000";

function seedEscrowConfig() {
  (stores.escrow_config ??= []).push({
    id: 1,
    custodyMode: "pssp",
    platformFeeRate: "0.03125",
    buyerConfirmWindowHours: 24,
    disputeWindowHours: 48,
    autoConfirmEnabled: true,
    floatYieldRate: "0.08",
    updatedAt: new Date(),
  });
}

function seedOrder(overrides: Record<string, unknown> = {}) {
  const order = {
    id: crypto.randomUUID(),
    tenantId: T,
    customerId: PHONE,
    orderNumber: "ORD-100",
    paymentStatus: "completed",
    status: "shipped",
    createdAt: new Date("2026-01-15T10:00:00Z"),
    updatedAt: new Date(),
    ...overrides,
  };
  (stores.orders ??= []).push(order);
  return order;
}

function seedEscrow(orderId: string, state: string, tenantId = T) {
  (stores.escrow_transactions ??= []).push({
    id: `escrow-${orderId}`,
    orderId,
    tenantId,
    amount: "5000.00",
    currency: "NGN",
    custodyMode: "pssp",
    state,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return `escrow-${orderId}`;
}

const notifyAdmin = vi.fn(async () => ({}));

beforeEach(() => {
  for (const k of Object.keys(stores)) delete stores[k];
  emitNotificationMock.mockClear();
  notifyAdmin.mockClear();
  seedEscrowConfig();
});

describe("classifyDisputeReason", () => {
  it("maps complaint text to reason enums", () => {
    expect(classifyDisputeReason("my order never arrived")).toBe("not_received");
    expect(classifyDisputeReason("you sent the wrong item")).toBe("wrong_item");
    expect(classifyDisputeReason("the pack arrived damaged")).toBe("damaged");
    expect(classifyDisputeReason("order was incomplete, items missing")).toBe("partial_delivery");
    expect(classifyDisputeReason("i am unhappy")).toBe("other");
  });
});

describe("raiseChatDispute", () => {
  it("creates an escrow dispute for an escrow-backed order + notifies admin", async () => {
    const order = seedOrder();
    seedEscrow(order.id, "escrow_held");
    const result = await raiseChatDispute({
      db, tenantId: T, phone: PHONE,
      complaintText: "My order never arrived",
      adminPhone: ADMIN,
      notifyAdminImpl: notifyAdmin,
    });
    expect(result.status).toBe("created");
    expect(result.reason).toBe("not_received");
    expect(result.disputeId).toBeTruthy();
    // Dispute row: open, buyer-raised, on the right tenant/order.
    const row = stores.escrow_disputes[0] as any;
    expect(row.status).toBe("open");
    expect(row.raisedBy).toBe("buyer");
    expect(row.tenantId).toBe(T);
    expect(row.orderId).toBe(order.id);
    expect(row.reason).toBe("not_received");
    // Escrow frozen by the guarded transition.
    expect((stores.escrow_transactions[0] as any).state).toBe("dispute_raised");
    // Admin phone notified.
    expect(notifyAdmin).toHaveBeenCalledWith(
      T, ADMIN, expect.stringContaining("ORD-100"),
    );
    // Buyer confirmation references the order.
    expect(buildDisputeReply(result)).toContain("ORD-100");
  });

  it("refuses to freeze a terminal escrow but still notifies", async () => {
    const order = seedOrder();
    seedEscrow(order.id, "settled");
    const result = await raiseChatDispute({
      db, tenantId: T, phone: PHONE,
      complaintText: "wrong item delivered",
      adminPhone: ADMIN,
      notifyAdminImpl: notifyAdmin,
    });
    expect(result.status).toBe("not_disputable");
    expect(stores.escrow_disputes ?? []).toHaveLength(0);
    expect((stores.escrow_transactions[0] as any).state).toBe("settled");
    expect(emitNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "dispute_opened", tenantId: T }),
    );
    expect(notifyAdmin).toHaveBeenCalled();
  });

  it("falls back to a merchant notification when the order has no escrow", async () => {
    seedOrder();
    const result = await raiseChatDispute({
      db, tenantId: T, phone: PHONE,
      complaintText: "the food was spoilt",
      adminPhone: ADMIN,
      notifyAdminImpl: notifyAdmin,
    });
    expect(result.status).toBe("notification_only");
    expect(result.reason).toBe("damaged");
    expect(emitNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispute_opened",
        tenantId: T,
        metadata: expect.objectContaining({ source: "whatsapp_chat" }),
      }),
    );
    expect(notifyAdmin).toHaveBeenCalledWith(T, ADMIN, expect.stringContaining("ORD-100"));
  });

  it("returns no_order (admin still notified) when the buyer has no orders", async () => {
    const result = await raiseChatDispute({
      db, tenantId: T, phone: PHONE,
      complaintText: "where is my stuff",
      adminPhone: ADMIN,
      notifyAdminImpl: notifyAdmin,
    });
    expect(result.status).toBe("no_order");
    expect(notifyAdmin).toHaveBeenCalledWith(T, ADMIN, expect.stringContaining("no order found"));
    expect(buildDisputeReply(result)).toMatch(/order number/i);
  });

  it("cannot touch another tenant's order (ownership)", async () => {
    const foreign = seedOrder({ tenantId: "tenant-2", orderNumber: "ORD-F" });
    seedEscrow(foreign.id, "escrow_held", "tenant-2");
    const result = await raiseChatDispute({
      db,
      tenantId: T, // tenant-1 context referencing tenant-2's order id
      phone: PHONE,
      complaintText: "never arrived",
      orderId: foreign.id,
      adminPhone: ADMIN,
      notifyAdminImpl: notifyAdmin,
    });
    expect(result.status).toBe("no_order");
    expect(stores.escrow_disputes ?? []).toHaveLength(0);
    expect((stores.escrow_transactions[0] as any).state).toBe("escrow_held"); // untouched
  });
});
