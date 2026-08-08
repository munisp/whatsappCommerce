/**
 * compliance.test.ts
 * Tests for the NDPR/GDPR privacy router, AML fraud-case filing queue,
 * monthly settlement report math, audit trail, and fraud-path pen-tests.
 *
 * DB-dependent procedures are tested with a stateful in-memory mock whose
 * guarded transitions mirror the SQL guards (optimistic claim, status-guarded
 * requeue) used by the real drizzle queries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";
import { resolveAttemptOutcome, FRAUD_CASE_MAX_ATTEMPTS } from "./routers/fraudCase";
import { buildSettlementReport, momDelta } from "./routers/report";
import { assessFraudRisk, FRAUD_HIGH_RISK_THRESHOLD } from "./services/fraud";

// ─── Stateful mock stores ────────────────────────────────────────────────────
const fraudStore: Record<string, any>[] = [];
const auditStore: Record<string, any>[] = [];
const notifStore: Record<string, any>[] = [];
const erasureStore: Record<string, any>[] = [];

// Configurable per-test row sources
let userRow: Record<string, any> | null = null;
let customerRows: Record<string, any>[] = [];
let orderRows: Record<string, any>[] = [];
let escrowRows: Record<string, any>[] = [];
let openEscrowRows: Record<string, any>[] = [];
let walletRow: Record<string, any> | null = null;
let walletTxRows: Record<string, any>[] = [];
let pendingWithdrawalRows: Record<string, any>[] = [];
let userUpdates: Record<string, any>[] = [];
let customerUpdates: Record<string, any>[] = [];

const tableName = (t: unknown) => {
  try { return getTableName(t as Parameters<typeof getTableName>[0]); } catch { return ""; }
};

function thenable(rows: unknown[]) {
  const self: Record<string, unknown> = {};
  const chain = () => thenable(rows);
  self["orderBy"] = chain;
  self["limit"] = (n: number) => thenable(rows.slice(0, n));
  self["offset"] = chain;
  self["then"] = (resolve: (v: unknown) => void) => { resolve(rows); return self; };
  self["catch"] = () => self;
  self["finally"] = (cb: () => void) => { cb(); return self; };
  return self;
}

function selectRows(table: unknown, fields?: Record<string, unknown>): unknown[] {
  const name = tableName(table);
  // Real drivers return snapshot copies — clone so mock updates can't mutate
  // rows a procedure already read (otherwise optimistic-claim bugs hide).
  const clone = (rows: Record<string, any>[]) => rows.map((r) => ({ ...r }));
  switch (name) {
    case "users": return userRow ? [userRow] : [];
    case "customers": return customerRows;
    case "orders": return orderRows;
    case "escrow_transactions":
      // Guard query selects { id } for OPEN escrows; export selects full rows.
      return fields && "id" in fields && Object.keys(fields).length === 1
        ? openEscrowRows
        : escrowRows;
    case "merchant_wallets": return walletRow ? [walletRow] : [];
    case "wallet_transactions": return walletTxRows;
    case "fraud_cases":
      // retryFailed's follow-up selects { status }; processQueue/list select
      // full rows — only 'pending' rows are claimable, so surface those.
      return fields && "status" in fields && Object.keys(fields).length === 1
        ? fraudStore.map((r) => ({ status: r.status }))
        : clone(fraudStore.filter((r) => r.status === "pending"));
    case "audit_logs": return auditStore;
    case "erasure_requests": return erasureStore;
    default: return [];
  }
}

function makeMockDb() {
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => thenable(selectRows(table, fields)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const name = tableName(table);
        const row = { id: crypto.randomUUID(), ...vals };
        if (name === "fraud_cases") fraudStore.push({ attempts: 0, status: "pending", ...row });
        else if (name === "merchant_notifications") notifStore.push(row);
        else if (name === "audit_logs") auditStore.push(row);
        else if (name === "erasure_requests") erasureStore.push(row);
        return {
          returning: () => Promise.resolve([row]),
          then: (resolve: (v: unknown) => void) => { resolve([row]); return Promise.resolve([row]); },
          catch: () => Promise.resolve([row]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          const name = tableName(table);
          const applyUpdate = (): Record<string, any>[] => {
            if (name === "users") { userUpdates.push(vals); if (userRow) Object.assign(userRow, vals); return userRow ? [userRow] : []; }
            if (name === "customers") { customerUpdates.push(vals); return customerRows; }
            if (name !== "fraud_cases") return [];
            // Mirror the SQL guards of the real queries:
            if (vals.attempts !== undefined && vals.lastAttemptAt !== undefined) {
              // Optimistic claim: pending + expected previous attempts only.
              const row = fraudStore.find((r) => r.status === "pending" && r.attempts === (vals.attempts as number) - 1);
              if (!row) return [];
              Object.assign(row, vals);
              return [row];
            }
            if (vals.status === "pending") {
              // Guarded requeue: failed → pending, exactly one winner.
              const row = fraudStore.find((r) => r.status === "failed");
              if (!row) return [];
              Object.assign(row, vals);
              return [row];
            }
            // Outcome update (filed / failed / dead_letter): last claimed row.
            const row = fraudStore.find((r) => r.status === "pending" && r.lastAttemptAt);
            if (!row) return [];
            Object.assign(row, vals);
            return [row];
          };
          const updated = applyUpdate();
          return {
            returning: () => Promise.resolve(updated),
            then: (resolve: (v: unknown) => void) => { resolve(updated); return Promise.resolve(updated); },
            catch: () => Promise.resolve(updated),
          };
        },
      }),
    }),
    execute: (_query: unknown) => Promise.resolve(pendingWithdrawalRows),
  };
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeMockDb())),
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
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

const { appRouter } = await import("./routers");

// ─── Context helpers ─────────────────────────────────────────────────────────
function makeCtx(role: "admin" | "user" = "admin", id = 1): TrpcContext {
  return {
    user: {
      id,
      openId: `test-user-${id}`,
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function seedFraudCase(overrides: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    tenantId: "tenant-1",
    paymentIntentId: "pi-1",
    orderId: "order-1",
    customerId: "cust-1",
    fraudScore: "0.8500",
    riskLevel: "high",
    status: "pending",
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    filedAt: null,
    payload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  fraudStore.push(row);
  return row;
}

beforeEach(() => {
  fraudStore.length = 0;
  auditStore.length = 0;
  notifStore.length = 0;
  erasureStore.length = 0;
  userRow = null;
  customerRows = [];
  orderRows = [];
  escrowRows = [];
  openEscrowRows = [];
  walletRow = null;
  walletTxRows = [];
  pendingWithdrawalRows = [];
  userUpdates = [];
  customerUpdates = [];
  delete process.env.AML_WEBHOOK_URL;
});

// ─── Fraud-case attempt state machine (pure) ─────────────────────────────────
describe("fraudCase attempt state machine", () => {
  it("successful filing transitions to filed with incremented attempts", () => {
    expect(resolveAttemptOutcome({ success: true, attempts: 0 }))
      .toEqual({ status: "filed", attempts: 1 });
  });

  it("failed attempt below max retries as failed", () => {
    expect(resolveAttemptOutcome({ success: false, attempts: 0 }))
      .toEqual({ status: "failed", attempts: 1 });
    expect(resolveAttemptOutcome({ success: false, attempts: 1 }))
      .toEqual({ status: "failed", attempts: 2 });
  });

  it("dead-letters (DLQ) after max attempts", () => {
    const out = resolveAttemptOutcome({ success: false, attempts: FRAUD_CASE_MAX_ATTEMPTS - 1 });
    expect(out).toEqual({ status: "dead_letter", attempts: FRAUD_CASE_MAX_ATTEMPTS });
  });
});

// ─── Fraud-case queue (mocked DB) ────────────────────────────────────────────
describe("fraudCase router (mocked DB)", () => {
  it("processQueue files a pending case via the notification path", async () => {
    const c = seedFraudCase();
    const caller = appRouter.createCaller(makeCtx("admin"));
    const res = await caller.fraudCase.processQueue({ limit: 10 });
    expect(res).toEqual({ processed: 1, filed: 1, failed: 0, deadLettered: 0 });
    expect(fraudStore[0].status).toBe("filed");
    expect(fraudStore[0].attempts).toBe(1);
    expect(fraudStore[0].filedAt).toBeTruthy();
    expect(notifStore.some((n) => n.metadata?.fraudCaseId === c.id)).toBe(true);
    // Filing leaves an audit trail row
    expect(auditStore.some((a) => a.action === "fraudCase.processQueue" && a.entityId === c.id)).toBe(true);
  });

  it("retry cycle: failed filing → retryFailed requeues → processQueue files", async () => {
    process.env.AML_WEBHOOK_URL = "http://localhost:1/unreachable"; // force filing failure
    const c = seedFraudCase();
    const caller = appRouter.createCaller(makeCtx("admin"));

    const first = await caller.fraudCase.processQueue({ limit: 10 });
    expect(first.failed).toBe(1);
    expect(fraudStore[0].status).toBe("failed");
    expect(fraudStore[0].attempts).toBe(1);
    expect(fraudStore[0].lastError).toBeTruthy();

    delete process.env.AML_WEBHOOK_URL; // webhook "recovers"
    const retry = await caller.fraudCase.retryFailed({ caseId: c.id });
    expect(retry.status).toBe("pending");
    // Requeue produces an exportable audit row
    expect(auditStore.some((a) => a.action === "fraudCase.retryFailed" && a.entityId === c.id)).toBe(true);

    const second = await caller.fraudCase.processQueue({ limit: 10 });
    expect(second.filed).toBe(1);
    expect(fraudStore[0].status).toBe("filed");
    expect(fraudStore[0].attempts).toBe(2);
  });

  it("dead-letters after max failed attempts via processQueue", async () => {
    process.env.AML_WEBHOOK_URL = "http://localhost:1/unreachable";
    seedFraudCase({ attempts: FRAUD_CASE_MAX_ATTEMPTS - 1, status: "pending" });
    const caller = appRouter.createCaller(makeCtx("admin"));
    const res = await caller.fraudCase.processQueue({ limit: 10 });
    expect(res.deadLettered).toBe(1);
    expect(fraudStore[0].status).toBe("dead_letter");
    expect(fraudStore[0].attempts).toBe(FRAUD_CASE_MAX_ATTEMPTS);
  });

  it("concurrent requeue is safe: only one retryFailed wins the failed→pending guard", async () => {
    const c = seedFraudCase({ status: "failed", attempts: 1, lastError: "boom" });
    const caller = appRouter.createCaller(makeCtx("admin"));
    const results = await Promise.allSettled([
      caller.fraudCase.retryFailed({ caseId: c.id }),
      caller.fraudCase.retryFailed({ caseId: c.id }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fraudStore[0].status).toBe("pending");
  });

  it("concurrent processQueue workers cannot double-file the same case", async () => {
    seedFraudCase();
    const caller = appRouter.createCaller(makeCtx("admin"));
    const [a, b] = await Promise.all([
      caller.fraudCase.processQueue({ limit: 10 }),
      caller.fraudCase.processQueue({ limit: 10 }),
    ]);
    expect(a.processed + b.processed).toBe(1);
    expect(fraudStore[0].attempts).toBe(1);
    expect(fraudStore[0].status).toBe("filed");
    expect(notifStore).toHaveLength(1);
  });

  it("non-admin cannot mark their own case filed (FORBIDDEN)", async () => {
    const c = seedFraudCase();
    const caller = appRouter.createCaller(makeCtx("user", 42));
    await expect(caller.fraudCase.markFiled({ caseId: c.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fraudStore[0].status).toBe("pending");
  });

  it("non-admin cannot processQueue / retryFailed / list", async () => {
    const c = seedFraudCase({ status: "failed", attempts: 1 });
    const caller = appRouter.createCaller(makeCtx("user"));
    await expect(caller.fraudCase.processQueue({ limit: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.fraudCase.retryFailed({ caseId: c.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.fraudCase.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── Fraud risk heuristic + pen-test payloads ────────────────────────────────
describe("fraud risk heuristic (pen-test payloads)", () => {
  it("flags crafted extreme payload: huge amount, no phone, no customer", () => {
    const r = assessFraudRisk({ amount: 5_000_000, numItems: 0, phone: null, customerId: null });
    // 0.05 + 0.40 + 0.30 + 0.15 = 0.90 → high
    expect(r.fraudProbability).toBeCloseTo(0.90, 5);
    expect(r.riskLevel).toBe("high");
    expect(r.fraudProbability).toBeGreaterThan(FRAUD_HIGH_RISK_THRESHOLD);
  });

  it("flags zero-amount + anonymous payload (probing attack)", () => {
    const r = assessFraudRisk({ amount: 0, phone: "0803", customerId: null });
    // 0.05 + 0.30 + 0.15 + 0.50 = 1.00 → clamped 0.99 → high
    expect(r.fraudProbability).toBe(0.99);
    expect(r.riskLevel).toBe("high");
  });

  it("does NOT flag an ordinary low-risk order", () => {
    const r = assessFraudRisk({ amount: 15_000, numItems: 2, phone: "08031234567", customerId: "cust-1" });
    expect(r.riskLevel).toBe("low");
  });

  it("bulk-order + high amount without phone lands at least medium", () => {
    const r = assessFraudRisk({ amount: 200_000, numItems: 60, phone: null, customerId: "cust-1" });
    // 0.05 + 0.20 + 0.25 + 0.30 = 0.80 → high
    expect(r.riskLevel).toBe("high");
  });

  it("NaN amount is treated as 0 (probing) and flagged", () => {
    const r = assessFraudRisk({ amount: NaN, phone: null, customerId: null });
    expect(r.riskLevel).toBe("high");
  });
});

// ─── Monthly settlement report math ──────────────────────────────────────────
describe("report.monthlySettlement math (seeded rows, hand-computed)", () => {
  it("computes per-tenant figures and MoM deltas", () => {
    const current = [
      { tenantId: "t-a", grossVolume: 1000, platformFees: 31.25, netMerchantPayouts: 968.75, refundTotals: 100 },
      { tenantId: "t-b", grossVolume: 500, platformFees: 15.63, netMerchantPayouts: 484.37, refundTotals: 0 },
    ];
    const previous = [
      { tenantId: "t-a", grossVolume: 500, platformFees: 15.63, netMerchantPayouts: 484.37, refundTotals: 50 },
      { tenantId: "t-b", grossVolume: 0, platformFees: 0, netMerchantPayouts: 0, refundTotals: 0 },
    ];
    const inFlight = new Map([["t-a", 250]]);

    const report = buildSettlementReport(current, previous, inFlight);
    const a = report.find((r) => r.tenantId === "t-a")!;
    const b = report.find((r) => r.tenantId === "t-b")!;

    // Hand-computed: t-a gross doubled → +100%; refunds 50→100 → +100%
    expect(a.grossVolume).toBe(1000);
    expect(a.escrowInFlight).toBe(250);
    expect(a.deltas.grossVolumePct).toBe(100);
    expect(a.deltas.refundTotalsPct).toBe(100);
    // fees 15.63 → 31.25 = +99.94% (rounded to 2dp)
    expect(a.deltas.platformFeesPct).toBeCloseTo(99.94, 2);

    // t-b previous was zero → delta null (undefined baseline), current shown
    expect(b.deltas.grossVolumePct).toBeNull();
    expect(b.escrowInFlight).toBe(0);
  });

  it("includes tenants that only have in-flight escrow", () => {
    const report = buildSettlementReport([], [], new Map([["t-c", 75]]));
    expect(report).toHaveLength(1);
    expect(report[0].tenantId).toBe("t-c");
    expect(report[0].escrowInFlight).toBe(75);
    expect(report[0].grossVolume).toBe(0);
  });

  it("momDelta: 0→0 is 0, 0→x is null, negative deltas computed", () => {
    expect(momDelta(0, 0)).toBe(0);
    expect(momDelta(5, 0)).toBeNull();
    expect(momDelta(50, 100)).toBe(-50);
  });

  it("non-admin cannot call monthlySettlement", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    await expect(caller.report.monthlySettlement({ month: "2026-01" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects malformed month input", async () => {
    const caller = appRouter.createCaller(makeCtx("admin"));
    await expect(caller.report.monthlySettlement({ month: "2026-13" })).rejects.toThrow();
  });
});

// ─── Privacy: export + erasure ───────────────────────────────────────────────
describe("privacy router (mocked DB)", () => {
  const baseUser = {
    id: 7, openId: "u-7", name: "Ada Lovelace", email: "ada@example.com",
    phone: "08031234567", role: "user", tenantId: null,
  };

  it("exportMyData gathers user, profiles, orders, escrows", async () => {
    userRow = { ...baseUser };
    customerRows = [{ id: "cust-1" }];
    orderRows = [{ id: "o-1", customerId: "cust-1" }];
    escrowRows = [{ id: "e-1", customerId: "cust-1" }];
    const caller = appRouter.createCaller(makeCtx("user", 7));
    const out = await caller.privacy.exportMyData();
    expect(out.user.email).toBe("ada@example.com");
    expect(out.customerProfiles).toEqual(["cust-1"]);
    expect(out.orders).toHaveLength(1);
    expect(out.escrowTransactions).toHaveLength(1);
    expect(out.merchantWallet).toBeNull();
  });

  it("requestErasure anonymizes PII and keeps financial rows", async () => {
    userRow = { ...baseUser };
    customerRows = [{ id: "cust-1" }];
    orderRows = [{ id: "o-1", customerId: "cust-1" }];
    const caller = appRouter.createCaller(makeCtx("user", 7));
    const out = await caller.privacy.requestErasure({ reason: "no longer using the service" });
    expect(out.status).toBe("completed");
    // PII nulled on the user record
    expect(userUpdates[0]).toMatchObject({ name: null, email: null, phone: null });
    // Customer profiles tombstoned
    expect(customerUpdates[0]).toMatchObject({ name: null, email: null });
    // Financial rows untouched (orders still present)
    expect(orderRows).toHaveLength(1);
    // Erasure request recorded + audit row written
    expect(erasureStore[0].status).toBe("completed");
    expect(auditStore.some((a) => a.action === "privacy.erasure" && a.entityId === "7")).toBe(true);
  });

  it("requestErasure is honestly blocked by open escrows", async () => {
    userRow = { ...baseUser };
    customerRows = [{ id: "cust-1" }];
    openEscrowRows = [{ id: "e-open" }];
    const caller = appRouter.createCaller(makeCtx("user", 7));
    const out = await caller.privacy.requestErasure({});
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("open_escrows");
    expect(userUpdates).toHaveLength(0); // no anonymization happened
    expect(erasureStore[0].blockedReason).toBe("open_escrows");
  });

  it("requestErasure is blocked by pending withdrawals on the merchant wallet", async () => {
    userRow = { ...baseUser, tenantId: "tenant-9" };
    pendingWithdrawalRows = [{ id: "wt-1" }];
    const caller = appRouter.createCaller(makeCtx("user", 7));
    const out = await caller.privacy.requestErasure({});
    expect(out.status).toBe("blocked");
    expect(out.reason).toBe("pending_withdrawals");
  });

  it("listErasureRequests is admin-only", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    await expect(caller.privacy.listErasureRequests({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("unauthenticated caller is rejected", async () => {
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(caller.privacy.exportMyData()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ─── Audit export ────────────────────────────────────────────────────────────
describe("audit.export", () => {
  it("admin can export rows written by fraud-case requeue", async () => {
    const c = seedFraudCase({ status: "failed", attempts: 1 });
    const caller = appRouter.createCaller(makeCtx("admin"));
    await caller.fraudCase.retryFailed({ caseId: c.id });

    const out = await caller.audit.export({ action: "fraudCase.retryFailed" });
    expect(out.count).toBe(1);
    expect(out.rows[0]).toMatchObject({
      action: "fraudCase.retryFailed",
      entityType: "fraud_case",
      entityId: c.id,
    });
  });

  it("non-admin cannot export the audit trail", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    await expect(caller.audit.export({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
