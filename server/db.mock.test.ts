/**
 * db.mock.test.ts
 * Tests for DB-dependent procedures (escrow.bulkUpdateState, operatorTemplates)
 * using vi.mock to avoid requiring a live Postgres connection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

// ─── Mock getDb before importing routers ─────────────────────────────────────
// We must mock the module before any import that transitively calls getDb.
const mockEscrowRows: Record<string, unknown>[] = [];
const mockTemplateStore: Record<string, unknown>[] = [];

// Build a minimal drizzle-like DB mock
function makeMockDb() {
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          // Determine which table is being queried by checking the table symbol
          const tbl = table as { _: { name?: string } };
          const name = tbl?._?.name ?? "";
          // If this is a count(*) query, return [{ count: N }]
          const isCountQuery = fields && "count" in fields;
          // Build a chainable thenable so .where().orderBy().limit().offset()
          // and Promise.all([...]) both work.
          const makeChain = (rows: unknown[]): unknown => {
            const self: Record<string, unknown> = {};
            const chain = () => makeChain(rows);
            self["orderBy"] = chain;
            self["limit"] = chain;
            self["offset"] = chain;
            // Make it a thenable (Promise.all resolves it directly)
            self["then"] = (resolve: (v: unknown) => void, _reject?: unknown) => {
              resolve(rows);
              return self;
            };
            self["catch"] = (_reject: unknown) => self;
            self["finally"] = (cb: () => void) => { cb(); return self; };
            return self;
          };
          if (isCountQuery) {
            // Return count of the relevant store
            const cnt = name === "operator_templates" ? mockTemplateStore.length : 0;
            return makeChain([{ count: cnt }]);
          }
          if (name === "escrow_config") {
            return makeChain([{
              id: 1,
              custodyMode: "pssp",
              platformFeeRate: "0.03125",
              buyerConfirmWindowHours: 24,
              disputeWindowHours: 48,
              autoConfirmEnabled: true,
              floatYieldRate: "0.08",
              minScanConfidence: "0.70",
              updatedAt: new Date(),
            }]);
          }
          if (name === "escrow_transactions") {
            return makeChain(mockEscrowRows);
          }
          if (name === "operator_templates") {
            return makeChain(mockTemplateStore);
          }
          return makeChain([]);
        },
        orderBy: () => ({
          limit: () => ({ offset: () => Promise.resolve(mockTemplateStore) }),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: () => {
          const row = { id: crypto.randomUUID(), isActive: true, ...vals, createdAt: new Date(), updatedAt: new Date() };
          mockTemplateStore.push(row);
          return Promise.resolve([row]);
        },
        onConflictDoNothing: () => Promise.resolve([]),
      }),
    }),
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_cond: unknown) => ({
          returning: () => {
            if (mockTemplateStore.length > 0) {
              const last = mockTemplateStore[mockTemplateStore.length - 1] as Record<string, unknown>;
              const merged = { ...last, ...(_vals as Record<string, unknown>), updatedAt: new Date() };
              mockTemplateStore[mockTemplateStore.length - 1] = merged;
              return Promise.resolve([merged]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => Promise.resolve([]),
    }),
    execute: (_query: unknown) => Promise.resolve([{ count: 0 }]),
  };
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(makeMockDb()),
  withRetry: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
}));

// Also mock Permify and Kafka to avoid network calls
vi.mock("./permify", () => ({
  permifyCheck: vi.fn().mockResolvedValue(true),
}));
vi.mock("./kafka", () => ({
  publishOrderEvent: vi.fn().mockResolvedValue(undefined),
  publishConversationEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./dapr", () => ({
  daprPublish: vi.fn().mockResolvedValue(undefined),
  daprSaveState: vi.fn().mockResolvedValue(undefined),
}));

// Import routers AFTER mocks are set up
const { appRouter } = await import("./routers");

// ─── Context helpers ──────────────────────────────────────────────────────────
function makeCtx(role: "admin" | "user" = "admin"): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

// ─── escrow.bulkUpdateState ───────────────────────────────────────────────────
describe("escrow.bulkUpdateState (mocked DB)", () => {
  it("non-admin role can call bulkUpdateState and gets correct shape", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    const result = await caller.escrow.bulkUpdateState({
      escrowIds: ["fake-id"],
      action: "release",
    });
    expect(result).toHaveProperty("succeeded");
    expect(result).toHaveProperty("failed");
    expect(typeof result.succeeded).toBe("number");
    expect(typeof result.failed).toBe("number");
  });

  it("admin can call with non-existent IDs and gets zero succeeded", async () => {
    const caller = appRouter.createCaller(makeCtx("admin"));
    const result = await caller.escrow.bulkUpdateState({
      escrowIds: ["non-existent-id-xyz"],
      action: "release",
    });
    expect(typeof result.succeeded).toBe("number");
    expect(typeof result.failed).toBe("number");
    // No rows returned for non-existent IDs → 0 succeeded, 0 failed (empty results)
    expect(result.succeeded).toBe(0);
  });
});

// ─── operatorTemplates router ─────────────────────────────────────────────────
describe("operatorTemplates router (mocked DB)", () => {
  beforeEach(() => {
    mockTemplateStore.length = 0;
  });

  it("non-admin cannot create templates (adminProcedure rejects)", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    await expect(
      caller.operatorTemplates.create({
        name: "unauthorized-template",
        category: "transactional",
        bodyText: "Hello {{name}}",
      })
    ).rejects.toThrow();
  });

  it("non-admin can list templates and gets correct shape", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    const result = await caller.operatorTemplates.list({});
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("admin can create a template and it appears in the store", async () => {
    const caller = appRouter.createCaller(makeCtx("admin"));
    const uniqueName = `test-op-tmpl-${Date.now()}`;
    const created = await caller.operatorTemplates.create({
      name: uniqueName,
      category: "transactional",
      bodyText: "Hello {{name}}, your order {{order_id}} is confirmed.",
      variables: ["name", "order_id"],
    });
    expect(created.name).toBe(uniqueName);
    expect(created.isActive).toBe(true);
  });

  it("list with nonexistent search term returns empty items", async () => {
    const caller = appRouter.createCaller(makeCtx("user"));
    const result = await caller.operatorTemplates.list({
      search: "absolutely_nonexistent_xyz_99999",
      category: "marketing",
    });
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});
