/**
 * tenantIsolation.test.ts — Multi-tenant isolation + authorization matrix.
 *
 * Tenant A's authenticated ctx attempts to read/modify Tenant B's wallets,
 * escrows, orders, payment intents, payouts and integration configs. Every
 * procedure must throw FORBIDDEN/UNAUTHORIZED (or, for list endpoints, only
 * ever return Tenant-A-scoped rows).
 *
 * Runs against a mocked DB (same style as db.mock.test.ts). The mock actually
 * EVALUATES simple drizzle equality conditions (id = $n / tenant_id = $n /
 * col IN (...)) against in-memory rows, so procedures resolve the same rows
 * they would against a real database — cross-tenant ownership checks are
 * exercised for real.
 */
import { describe, it, expect, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

// ─── Fixtures ────────────────────────────────────────────────────────────────
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const escrowA = {
  id: "escrow-a-1", orderId: "order-a-1", tenantId: TENANT_A, customerId: "cust-a",
  amount: "500.00", platformFee: "15.63", netMerchantAmount: "484.37", currency: "NGN",
  custodyMode: "pssp", state: "escrow_held", autoConfirmed: false,
  metadata: {}, createdAt: new Date(), updatedAt: new Date(),
};
const escrowB = {
  id: "escrow-b-1", orderId: "order-b-1", tenantId: TENANT_B, customerId: "cust-b",
  amount: "1000.00", platformFee: "31.25", netMerchantAmount: "968.75", currency: "NGN",
  custodyMode: "pssp", state: "escrow_held", autoConfirmed: false,
  metadata: {}, createdAt: new Date(), updatedAt: new Date(),
};
const orderA = {
  id: "order-a-1", tenantId: TENANT_A, customerId: "cust-a", orderNumber: "ORD-A",
  status: "processing", paymentStatus: "completed", totalAmount: "500.00", currency: "NGN",
  items: [], createdAt: new Date(), updatedAt: new Date(),
};
const orderB = {
  id: "order-b-1", tenantId: TENANT_B, customerId: "cust-b", orderNumber: "ORD-B",
  status: "shipped", paymentStatus: "completed", totalAmount: "1000.00", currency: "NGN",
  items: [], createdAt: new Date(), updatedAt: new Date(),
};
const customerA = {
  id: "cust-a", tenantId: TENANT_A, email: "buyer-a@example.com", whatsappPhone: "+2340000000001",
  createdAt: new Date(), updatedAt: new Date(),
};
const customerB = {
  id: "cust-b", tenantId: TENANT_B, email: "buyer-b@example.com", whatsappPhone: "+2340000000002",
  createdAt: new Date(), updatedAt: new Date(),
};
const walletA = {
  id: "wallet-a", tenantId: TENANT_A, currency: "NGN", availableBalance: "250.00",
  escrowBalance: "500.00", totalEarned: "0", totalWithdrawn: "0", custodyMode: "psp",
  isActive: true, createdAt: new Date(), updatedAt: new Date(),
};
const walletB = {
  id: "wallet-b", tenantId: TENANT_B, currency: "NGN", availableBalance: "9999.00",
  escrowBalance: "1000.00", totalEarned: "0", totalWithdrawn: "0", custodyMode: "psp",
  isActive: true, createdAt: new Date(), updatedAt: new Date(),
};
const disputeB = {
  id: "dispute-b-1", escrowTxId: escrowB.id, orderId: orderB.id, tenantId: TENANT_B,
  raisedBy: "buyer", reason: "not_received", status: "open",
  createdAt: new Date(), updatedAt: new Date(),
};
const refundB = {
  id: "refund-b-1", orderId: orderB.id, tenantId: TENANT_B, amount: "1000.00",
  currency: "NGN", reason: "test", status: "pending", createdAt: new Date(), updatedAt: new Date(),
};
const escrowCfg = {
  id: 1, custodyMode: "pssp", platformFeeRate: "0.03125", buyerConfirmWindowHours: 24,
  disputeWindowHours: 48, autoConfirmEnabled: true, floatYieldRate: "0.08",
  minScanConfidence: "0.70", updatedAt: new Date(),
};

// Table name → row store. where() conditions are evaluated against these.
const stores: Record<string, Record<string, unknown>[]> = {
  escrow_config: [escrowCfg],
  escrow_transactions: [escrowA, escrowB],
  escrow_disputes: [disputeB],
  orders: [orderA, orderB],
  customers: [customerA, customerB],
  merchant_wallets: [walletA, walletB],
  wallet_transactions: [],
  payment_intents: [],
  payment_transactions: [],
  payment_gateway_configs: [],
  refunds: [refundB],
  order_items: [],
  escrow_timeline_attachments: [],
  odoo_integrations: [],
  twenty_integrations: [],
  tenant_integrations: [],
  medusa_integrations: [],
};

// ─── Condition evaluation (real drizzle SQL compilation) ─────────────────────
// We compile drizzle where-conditions with PgDialect and apply the simple
// equality/IN predicates to the in-memory rows, so e.g. a query for escrow id
// "escrow-b-1" really returns Tenant B's escrow.
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

function eqVal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

function filterRows(table: unknown, cond: unknown, rows: Record<string, unknown>[]): Record<string, unknown>[] {
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
      if (prop) tests.push((r) => eqVal(r[prop], val));
      continue;
    }
    const mIn = part.match(/"[\w]+"\."([\w]+)" in \(([^)]*)\)/i);
    if (mIn) {
      const prop = colMap[mIn[1]];
      const vals = mIn[2].split(",").map((s) => compiled.params[Number(s.trim().slice(1)) - 1]);
      if (prop) tests.push((r) => vals.some((v) => eqVal(r[prop], v)));
    }
    // Unrecognised predicates (>, IS NULL, ...) are treated as pass-through;
    // every fixture satisfies them for the purposes of these tests.
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

// ─── Drizzle-like mock DB ────────────────────────────────────────────────────
function makeChain(rows: Record<string, unknown>[]): unknown {
  const self: Record<string, unknown> = {};
  const chain = () => makeChain(rows);
  self["orderBy"] = chain;
  self["limit"] = chain;
  self["offset"] = chain;
  self["groupBy"] = chain;
  self["returning"] = () => Promise.resolve(rows);
  self["then"] = (resolve: (v: unknown) => void) => { resolve(rows); return self; };
  self["catch"] = () => self;
  self["finally"] = (cb: () => void) => { cb(); return self; };
  return self;
}

function makeMockDb() {
  const db = {
    select: (_fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        const all = stores[name] ?? [];
        const api: Record<string, unknown> = {};
        api["where"] = (cond: unknown) => makeChain(filterRows(table, cond, all));
        api["orderBy"] = () => ({ limit: () => ({ offset: () => Promise.resolve(all) }) });
        api["groupBy"] = () => makeChain(all);
        api["then"] = (resolve: (v: unknown) => void) => { resolve(all); return api; };
        return api;
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const name = getTableName(table as never);
        const row = { id: crypto.randomUUID(), ...vals, createdAt: new Date(), updatedAt: new Date() };
        (stores[name] ??= []).push(row);
        return {
          returning: () => Promise.resolve([row]),
          onConflictDoNothing: () => Promise.resolve([]),
          onConflictDoUpdate: () => Promise.resolve([row]),
          then: (resolve: (v: unknown) => void) => { resolve([row]); },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const name = getTableName(table as never);
          const matched = filterRows(table, cond, stores[name] ?? []);
          const simpleVals: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(vals)) {
            // Skip drizzle SQL expressions (balance arithmetic etc.)
            if (v == null || typeof v !== "object" || v instanceof Date) simpleVals[k] = v;
          }
          for (const row of matched) Object.assign(row, simpleVals, { updatedAt: new Date() });
          return {
            returning: () => Promise.resolve(matched),
            then: (resolve: (v: unknown) => void) => { resolve(matched); },
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const name = getTableName(table as never);
        const matched = filterRows(table, cond, stores[name] ?? []);
        stores[name] = (stores[name] ?? []).filter((r) => !matched.includes(r));
        return Promise.resolve(matched);
      },
    }),
    execute: (_q: unknown) => Promise.resolve([]),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}

// ─── Module mocks (must precede router import) ───────────────────────────────
vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeMockDb())),
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
  // db-helper functions used directly by some routers
  getPaymentIntents: vi.fn().mockResolvedValue([]),
  getTenants: vi.fn().mockResolvedValue([]),
  getTenantStats: vi.fn().mockResolvedValue({}),
  getTenantById: vi.fn().mockImplementation((id: string) =>
    Promise.resolve(
      id === TENANT_A || id === TENANT_B
        ? { id, name: id, settings: {}, status: "active" }
        : undefined,
    )),
  createTenant: vi.fn().mockResolvedValue(undefined),
  updateTenant: vi.fn().mockResolvedValue(undefined),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  getUserByOpenId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn().mockResolvedValue(true) }));
vi.mock("./kafka", () => ({
  publishOrderEvent: vi.fn().mockResolvedValue(undefined),
  publishConversationEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./dapr", () => ({
  daprPublish: vi.fn().mockResolvedValue(undefined),
  daprSaveState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./redis", () => ({
  acquireIdempotencyLock: vi.fn().mockResolvedValue(true),
  releaseIdempotencyLock: vi.fn().mockResolvedValue(undefined),
  redisIncrEx: vi.fn().mockResolvedValue(1),
}));
vi.mock("./temporal", () => ({
  startOrderFulfillmentWorkflow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "k", url: "/api/storage/k" }),
  storageGet: vi.fn().mockResolvedValue({ key: "k", url: "/api/storage/k" }),
}));
vi.mock("./services/medusaAdapter", () => ({
  medusaRequest: vi.fn().mockResolvedValue({}),
  getMedusaConfig: vi.fn().mockResolvedValue(null),
  isMedusaConfigured: vi.fn().mockReturnValue(false),
}));

const { appRouter } = await import("./routers");

// ─── Context helpers ─────────────────────────────────────────────────────────
function makeUser(role: "admin" | "user", tenantId: string | null, suffix: string): NonNullable<TrpcContext["user"]> {
  return {
    id: role === "admin" ? 1 : 2,
    openId: `openid-${suffix}`,
    email: `${suffix}@example.com`,
    name: `User ${suffix}`,
    loginMethod: "keycloak",
    role,
    tenantId,
    phone: null,
    phoneVerified: false,
    whatsappNotifOrders: true,
    whatsappNotifStatus: true,
    whatsappNotifMarketing: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as NonNullable<TrpcContext["user"]>;
}

function makeCtx(user: ReturnType<typeof makeUser> | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

// Tenant A merchant (role "user", bound to TENANT_A)
const callerA = appRouter.createCaller(makeCtx(makeUser("user", TENANT_A, "merchant-a")));
// Tenant B merchant (for bidirectional checks)
const callerB = appRouter.createCaller(makeCtx(makeUser("user", TENANT_B, "merchant-b")));
// Platform admin (control — admins bypass tenant scoping by design)
const callerAdmin = appRouter.createCaller(makeCtx(makeUser("admin", null, "platform-admin")));
// Unauthenticated
const callerAnon = appRouter.createCaller(makeCtx(null));

const FORBIDDEN = { code: "FORBIDDEN" } as const;

// ═══ 1. ESCROW — cross-tenant hold / confirm / dispute ═══════════════════════
describe("multi-tenant isolation: escrow", () => {
  it("escrow.createHold for Tenant B's tenantId is rejected for Tenant A", async () => {
    await expect(
      callerA.escrow.createHold({ orderId: orderB.id, tenantId: TENANT_B, amount: 1000 }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrow.confirmDelivery on Tenant B's escrow is rejected for Tenant A", async () => {
    await expect(
      callerA.escrow.confirmDelivery({ escrowId: escrowB.id }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrow.buyerConfirm on Tenant B's escrow is rejected for a non-buyer", async () => {
    await expect(
      callerA.escrow.buyerConfirm({ escrowId: escrowB.id, autoConfirmed: false }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrow.getByOrder leaks nothing of Tenant B to Tenant A", async () => {
    await expect(callerA.escrow.getByOrder({ orderId: orderB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrow.listAll with Tenant B's tenantId is rejected for Tenant A", async () => {
    await expect(callerA.escrow.listAll({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrow.getTimeline on Tenant B's escrow is rejected for Tenant A", async () => {
    await expect(callerA.escrow.getTimeline({ escrowId: escrowB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrow.getStats is admin-only (cross-tenant aggregate)", async () => {
    await expect(callerA.escrow.getStats()).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrowDispute.raise against Tenant B's escrow is rejected for Tenant A", async () => {
    await expect(
      callerA.escrowDispute.raise({
        escrowTxId: escrowB.id, orderId: orderB.id, tenantId: TENANT_B, reason: "not_received",
      }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrowDispute.list with Tenant B's tenantId is rejected for Tenant A", async () => {
    await expect(callerA.escrowDispute.list({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrowDispute.getByOrder for Tenant B's order is rejected for Tenant A", async () => {
    await expect(callerA.escrowDispute.getByOrder({ orderId: orderB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrowDispute.escalate on Tenant B's dispute is rejected for Tenant A", async () => {
    await expect(callerA.escrowDispute.escalate({ disputeId: disputeB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  it("escrowDispute.escalationSlaStats is admin-only", async () => {
    await expect(callerA.escrowDispute.escalationSlaStats()).rejects.toMatchObject(FORBIDDEN);
  });

  it("timelineAttachment.add on Tenant B's escrow is rejected for Tenant A", async () => {
    await expect(
      callerA.timelineAttachment.add({ escrowId: escrowB.id, eventId: "evt-1", note: "hi" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("timelineAttachment.list on Tenant B's escrow is rejected for Tenant A", async () => {
    await expect(callerA.timelineAttachment.list({ escrowId: escrowB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  // Positive controls: the same procedures work for the owning tenant/admin.
  it("control: Tenant B merchant can confirm delivery on their own escrow", async () => {
    const updated = await callerB.escrow.confirmDelivery({ escrowId: escrowB.id });
    expect(updated.state).toBe("delivery_confirmed");
  });

  it("control: Tenant A merchant reads their own escrow by order", async () => {
    const row = await callerA.escrow.getByOrder({ orderId: orderA.id });
    expect(row?.tenantId).toBe(TENANT_A);
  });
});

// ═══ 2. WALLET — balance / withdrawal / payouts ══════════════════════════════
describe("multi-tenant isolation: wallet", () => {
  it("wallet.getBalance for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.wallet.getBalance({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("wallet.listTransactions for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.wallet.listTransactions({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("wallet.requestWithdrawal from Tenant B's wallet is rejected for Tenant A", async () => {
    await expect(
      callerA.wallet.requestWithdrawal({ tenantId: TENANT_B, amount: 500 }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("wallet.exportLedgerCsv for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.wallet.exportLedgerCsv({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("wallet.topUp for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.wallet.topUp({ tenantId: TENANT_B, amount: 100 })).rejects.toMatchObject(FORBIDDEN);
  });

  it("wallet.getStats is admin-only (cross-tenant aggregate)", async () => {
    await expect(callerA.wallet.getStats()).rejects.toMatchObject(FORBIDDEN);
  });

  it("control: Tenant A merchant reads their own wallet balance", async () => {
    const w = await callerA.wallet.getBalance({ tenantId: TENANT_A });
    expect(w?.tenantId).toBe(TENANT_A);
  });
});

// ═══ 3. PAYMENTS — initiate / verify / list / stats ══════════════════════════
describe("multi-tenant isolation: payments", () => {
  it("payment.list for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.payment.list({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("payment.initiate against Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.payment.initiate({
        tenantId: TENANT_B, orderId: orderB.id, amount: 1000,
        provider: "paystack", customerPhone: "+2340000000002",
      }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("payment.stats for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.payment.stats({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("payment.reconcileLedger for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.payment.reconcileLedger({ tenantId: TENANT_B, accountId: "acct-b" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("paymentGateway.configure for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.paymentGateway.configure({ tenantId: TENANT_B, provider: "paystack", secretKey: "sk_live_x" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("paymentGateway.getConfig for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.paymentGateway.getConfig({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("paymentGateway.initiate for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.paymentGateway.initiate({ tenantId: TENANT_B, orderId: orderB.id, provider: "paystack" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("paymentGateway.verify for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.paymentGateway.verify({ tenantId: TENANT_B, transactionId: "tx-b-1" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("paymentGateway.listTransactions for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.paymentGateway.listTransactions({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("paymentGateway.verifyWebhookSignature for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.paymentGateway.verifyWebhookSignature({
        tenantId: TENANT_B, provider: "paystack", rawBody: "{}", signature: "sig",
      }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
});

// ═══ 4. ORDERS — read / update / cancel / refunds ════════════════════════════
describe("multi-tenant isolation: orders", () => {
  it("orderCrud.create for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.orderCrud.create({
        tenantId: TENANT_B, customerId: "cust-b",
        items: [{ productId: "p1", productName: "Widget", quantity: 1, unitPrice: 10 }],
      }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("orderCrud.get for Tenant B's order is rejected for Tenant A", async () => {
    await expect(callerA.orderCrud.get({ orderId: orderB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  it("orderCrud.updateStatus on Tenant B's order is rejected for Tenant A", async () => {
    await expect(
      callerA.orderCrud.updateStatus({ orderId: orderB.id, status: "cancelled" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("orderCrud.cancel on Tenant B's order is rejected for Tenant A", async () => {
    await expect(callerA.orderCrud.cancel({ orderId: orderB.id })).rejects.toMatchObject(FORBIDDEN);
  });

  it("orderCrud.refund on Tenant B's order is rejected for Tenant A", async () => {
    await expect(
      callerA.orderCrud.refund({ orderId: orderB.id, amount: 1000, reason: "hostile" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("orderCrud.listRefunds for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.orderCrud.listRefunds({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("orderCrud.processRefund on Tenant B's refund is rejected for Tenant A", async () => {
    await expect(
      callerA.orderCrud.processRefund({ refundId: refundB.id, action: "approved" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("control: Tenant B merchant reads their own order", async () => {
    const order = await callerB.orderCrud.get({ orderId: orderB.id });
    expect(order.tenantId).toBe(TENANT_B);
  });
});

// ═══ 5. TENANT / WHATSAPP / INTEGRATION CONFIGS ══════════════════════════════
describe("multi-tenant isolation: tenant & integration configs", () => {
  it("tenant.getWhatsAppConfig is admin-only (non-admin rejected)", async () => {
    await expect(callerA.tenant.getWhatsAppConfig({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("tenant.updateWhatsAppConfig is admin-only (non-admin rejected)", async () => {
    await expect(
      callerA.tenant.updateWhatsAppConfig({
        tenantId: TENANT_B, phoneNumberId: "1", wabaId: "2", accessToken: "x", verifyToken: "y",
      }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("tenant.get on another tenant is admin-only", async () => {
    await expect(callerA.tenant.get({ id: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("odoo.configure for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.odoo.configure({
        tenantId: TENANT_B, baseUrl: "https://odoo.example.com",
        database: "db", username: "u", apiKey: "k",
      }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("odoo.syncAll for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.odoo.syncAll({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("twenty.configure for Tenant B is rejected for Tenant A", async () => {
    await expect(
      callerA.twenty.configure({ tenantId: TENANT_B, apiUrl: "https://twenty.example.com", apiKey: "k" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it("twenty.syncContacts for Tenant B is rejected for Tenant A", async () => {
    await expect(callerA.twenty.syncContacts({ tenantId: TENANT_B })).rejects.toMatchObject(FORBIDDEN);
  });

  it("medusa.configure is admin-only", async () => {
    await expect(
      callerA.medusa.configure({ tenantId: TENANT_B, baseUrl: "https://medusa.example.com", apiKey: "sk" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
});

// ═══ 6. AUTHORIZATION MATRIX — money/admin procedures reject wrong role ══════
describe("authorization matrix: admin/money procedures reject non-admin", () => {
  it("escrow.setConfig", async () => {
    await expect(callerA.escrow.setConfig({ platformFeeRate: "0.5" })).rejects.toMatchObject(FORBIDDEN);
  });
  it("escrow.bankSettlementConfirmed", async () => {
    await expect(
      callerA.escrow.bankSettlementConfirmed({ escrowId: escrowA.id, bankRef: "X" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
  it("escrow.initiateRefund", async () => {
    await expect(
      callerA.escrow.initiateRefund({ escrowId: escrowA.id, reason: "r" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
  it("escrow.bulkUpdateState (release)", async () => {
    await expect(
      callerA.escrow.bulkUpdateState({ escrowIds: [escrowA.id], action: "release" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
  it("escrowDispute.review", async () => {
    await expect(
      callerA.escrowDispute.review({ disputeId: disputeB.id, resolution: "full_release_to_merchant" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
  it("wallet.reconcileTopUps", async () => {
    await expect(callerA.wallet.reconcileTopUps({})).rejects.toMatchObject(FORBIDDEN);
  });
  it("payment.confirm (verify)", async () => {
    await expect(
      callerA.payment.confirm({ reference: "PAY-1", providerStatus: "success" }),
    ).rejects.toMatchObject(FORBIDDEN);
  });
  it("apisix.listLive", async () => {
    await expect(callerA.apisix.listLive()).rejects.toMatchObject(FORBIDDEN);
  });
  it("apisix.syncAll", async () => {
    await expect(callerA.apisix.syncAll()).rejects.toMatchObject(FORBIDDEN);
  });
  it("apisix.deleteRoute", async () => {
    await expect(callerA.apisix.deleteRoute({ routeId: "trpc-api" })).rejects.toMatchObject(FORBIDDEN);
  });
  it("tenant.create", async () => {
    await expect(callerA.tenant.create({ name: "Evil", slug: "evil" })).rejects.toMatchObject(FORBIDDEN);
  });
  it("tenant.list", async () => {
    await expect(callerA.tenant.list({})).rejects.toMatchObject(FORBIDDEN);
  });
});

// ═══ 7. UNAUTHENTICATED ACCESS ═══════════════════════════════════════════════
describe("unauthenticated callers are rejected (UNAUTHORIZED)", () => {
  it("wallet.getBalance", async () => {
    await expect(callerAnon.wallet.getBalance({ tenantId: TENANT_A })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("escrow.listAll", async () => {
    await expect(callerAnon.escrow.listAll({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("orderCrud.get", async () => {
    await expect(callerAnon.orderCrud.get({ orderId: orderA.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("payment.initiate", async () => {
    await expect(
      callerAnon.payment.initiate({
        tenantId: TENANT_A, orderId: orderA.id, amount: 10, provider: "paystack", customerPhone: "1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ═══ 8. PATH TRAVERSAL — mlOps filesystem reads ══════════════════════════════
describe("path traversal: mlOps experiment ids are contained", () => {
  it("mlOps.getMlflowRuns rejects ../../.. escape", async () => {
    await expect(callerAdmin.mlOps.getMlflowRuns({ experimentId: "../../../etc" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("mlOps.getMlflowRuns rejects '..' and slash variants", async () => {
    await expect(callerAdmin.mlOps.getMlflowRuns({ experimentId: ".." })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerAdmin.mlOps.getMlflowRuns({ experimentId: "1/../../etc" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("mlOps.getMetricHistory rejects traversal", async () => {
    await expect(callerAdmin.mlOps.getMetricHistory({ experimentId: "../../../etc" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("mlOps.getMlflowRuns accepts a normal id (returns runs array)", async () => {
    const runs = await callerAdmin.mlOps.getMlflowRuns({ experimentId: "nonexistent-exp-1" });
    expect(Array.isArray(runs)).toBe(true);
  });
});
