import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ─── Mock DB ──────────────────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getTenants: vi.fn().mockResolvedValue([
    { id: "t1", name: "Acme Store", slug: "acme-store", plan: "growth", status: "active", aiEnabled: true, defaultCurrency: "USD", defaultLanguage: "en", createdAt: new Date(), updatedAt: new Date() },
  ]),
  getTenantStats: vi.fn().mockResolvedValue({ total: 5, active: 3, trial: 1, suspended: 1 }),
  getTenantById: vi.fn().mockResolvedValue({ id: "t1", name: "Acme Store", slug: "acme-store", plan: "growth", status: "active", aiEnabled: true, aiModel: "gpt-4o-mini", defaultCurrency: "USD", defaultLanguage: "en", createdAt: new Date(), updatedAt: new Date() }),
  createTenant: vi.fn().mockResolvedValue(undefined),
  updateTenant: vi.fn().mockResolvedValue(undefined),
  getProducts: vi.fn().mockResolvedValue([
    { id: "p1", tenantId: "t1", sku: "PROD-001", name: "Widget", price: "29.99", currency: "USD", status: "active", stockQuantity: 100, lowStockThreshold: 10, createdAt: new Date(), updatedAt: new Date() },
  ]),
  getProductStats: vi.fn().mockResolvedValue({ total: 10, active: 8, lowStock: 2 }),
  createProduct: vi.fn().mockResolvedValue(undefined),
  updateProduct: vi.fn().mockResolvedValue(undefined),
  getConversations: vi.fn().mockResolvedValue([]),
  getConversationStats: vi.fn().mockResolvedValue({ total: 50, open: 10, botActive: 30, humanActive: 5, resolved: 5, escalated: 3 }),
  getOrders: vi.fn().mockResolvedValue([]),
  getOrderStats: vi.fn().mockResolvedValue({ total: 100, pending: 10, confirmed: 20, delivered: 60, revenue: 12500.00 }),
  getPaymentIntents: vi.fn().mockResolvedValue([]),
  getAgentStats: vi.fn().mockResolvedValue({ total: 500, escalated: 15, avgLatency: 320, avgConfidence: 0.87 }),
  getServiceHealth: vi.fn().mockResolvedValue([
    { id: 1, serviceName: "API Gateway", status: "healthy", latencyMs: 12, errorRate: "0.01", lastCheckedAt: new Date(), details: null },
  ]),
  upsertServiceHealth: vi.fn().mockResolvedValue(undefined),
  getPlatformOverview: vi.fn().mockResolvedValue({ tenants: { total: 5, active: 3 }, revenue: 45000, orders: 320, conversations: 1200, agentInteractions: 8500 }),
  getCustomerCount: vi.fn().mockResolvedValue(250),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  getUserByOpenId: vi.fn().mockResolvedValue(undefined),
  insertAgentEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Context Factories ────────────────────────────────────────────────────────
function makeAdminCtx(): TrpcContext {
  return {
    user: { id: 1, openId: "admin-001", name: "Admin", email: "admin@example.com", loginMethod: "manus", role: "admin", tenantId: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as any,
    res: { clearCookie: vi.fn() } as any,
  };
}

function makeUserCtx(): TrpcContext {
  return {
    user: { id: 2, openId: "user-001", name: "User", email: "user@example.com", loginMethod: "manus", role: "user", tenantId: "t1", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as any,
    res: { clearCookie: vi.fn() } as any,
  };
}

function makeAnonCtx(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as any,
    res: { clearCookie: vi.fn() } as any,
  };
}

// ─── Auth Tests ───────────────────────────────────────────────────────────────
describe("auth", () => {
  it("me returns null for unauthenticated user", async () => {
    const caller = appRouter.createCaller(makeAnonCtx());
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });

  it("me returns user for authenticated user", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.auth.me();
    expect(result).not.toBeNull();
    expect(result?.role).toBe("admin");
  });

  it("logout clears session cookie", async () => {
    const ctx = makeAdminCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
  });
});

// ─── Tenant Tests ─────────────────────────────────────────────────────────────
describe("tenant", () => {
  it("list returns tenants for admin", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.tenant.list();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.name).toBe("Acme Store");
  });

  it("list throws FORBIDDEN for non-admin", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(caller.tenant.list()).rejects.toThrow();
  });

  it("stats returns aggregate counts for admin", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.tenant.stats();
    expect(result.total).toBe(5);
    expect(result.active).toBe(3);
  });

  it("get returns tenant by id", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.tenant.get({ id: "t1" });
    expect(result.slug).toBe("acme-store");
  });

  it("create returns new tenant id", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.tenant.create({ name: "Test Store", slug: "test-store", plan: "starter", defaultCurrency: "USD", defaultLanguage: "en", aiEnabled: true });
    expect(result.slug).toBe("test-store");
  });

  it("update succeeds for admin", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.tenant.update({ id: "t1", status: "active" });
    expect(result.success).toBe(true);
  });
});

// ─── Product Tests ────────────────────────────────────────────────────────────
describe("product", () => {
  it("list returns products for authenticated user", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.product.list({ tenantId: "t1" });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.sku).toBe("PROD-001");
  });

  it("stats returns product counts", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.product.stats({ tenantId: "t1" });
    expect(result.total).toBe(10);
    expect(result.lowStock).toBe(2);
  });

  it("create returns new product", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.product.create({ tenantId: "t1", sku: "NEW-001", name: "New Widget", price: "19.99", stockQuantity: 50 });
    expect(result.sku).toBe("NEW-001");
  });
});

// ─── Conversation Tests ───────────────────────────────────────────────────────
describe("conversation", () => {
  it("stats returns conversation counts", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.conversation.stats({ tenantId: "t1" });
    expect(result.total).toBe(50);
    expect(result.botActive).toBe(30);
    expect(result.escalated).toBe(3);
  });

  it("list returns conversations", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.conversation.list({ tenantId: "t1" });
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Order Tests ──────────────────────────────────────────────────────────────
describe("order", () => {
  it("stats returns revenue and counts", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.order.stats({ tenantId: "t1" });
    expect(result.revenue).toBe(12500);
    expect(result.total).toBe(100);
  });
});

// ─── Agent Tests ──────────────────────────────────────────────────────────────
describe("agent", () => {
  it("stats returns AI performance metrics", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.agent.stats({ tenantId: "t1" });
    expect(result.total).toBe(500);
    expect(result.avgLatency).toBe(320);
    expect(result.avgConfidence).toBe(0.87);
  });

  it("health returns service health list", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.agent.health();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.serviceName).toBe("API Gateway");
    expect(result[0]?.status).toBe("healthy");
  });
});

// ─── Analytics Tests ──────────────────────────────────────────────────────────
describe("analytics", () => {
  it("platformOverview returns cross-tenant metrics", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.analytics.platformOverview();
    expect(result?.tenants.total).toBe(5);
    expect(result?.revenue).toBe(45000);
    expect(result?.agentInteractions).toBe(8500);
  });

  it("tenantDashboard returns per-tenant metrics", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.analytics.tenantDashboard({ tenantId: "t1" });
    expect(result.conversations.botActive).toBe(30);
    expect(result.orders.revenue).toBe(12500);
    expect(result.agent.avgConfidence).toBe(0.87);
    expect(result.customers).toBe(250);
  });
});
