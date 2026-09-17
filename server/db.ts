import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { buildTlsOptions } from "./_core/tlsConfig";
import {
  InsertUser, users,
  tenants, InsertTenant, Tenant,
  products, InsertProduct, Product,
  customers, InsertCustomer, Customer,
  conversations, InsertConversation, Conversation,
  orders, InsertOrder, Order,
  paymentIntents, InsertPaymentIntent, PaymentIntent,
  agentEvents, InsertAgentEvent,
  webhookEvents, InsertWebhookEvent,
  serviceHealth,
  whatsappTemplates, InsertWhatsappTemplate, WhatsappTemplate,
  tenantMenuAssignments, TenantMenuAssignment,
  whatsappMenus, WhatsappMenu,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle<Record<string, never>>> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

/**
 * W42 merger: live-pointer to the CURRENT drizzle instance. Updated every
 * time getDb() (re)creates the pool — lets long-lived holders (the sim
 * world) follow withRetry/resetDbConnection pool swaps instead of binding
 * to an ended client.
 */
export const __currentDb: { db: ReturnType<typeof drizzle<Record<string, never>>> | null } = { db: null };

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const connStr = process.env.POSTGRES_URL || process.env.DATABASE_URL;
      // PG pool size is env-configurable (PG_POOL_MAX, default 10) so the
      // platform can scale per-replica connection budgets without rebuilds.
      const poolMax = (() => {
        const v = parseInt(process.env.PG_POOL_MAX ?? "", 10);
        return Number.isFinite(v) && v > 0 ? v : 10;
      })();
      _client = postgres(connStr!, {
        max: poolMax,
        idle_timeout: 30,
        connect_timeout: 10,
        max_lifetime: 1800,
        // W42 (PLT-17): bound slow-query pile-ups at the session level so a
        // stuck query cannot occupy a pooled connection (and queue every
        // request behind it) indefinitely. Values are server-side ms.
        connection: {
          statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS ?? "", 10) || 30_000,
          lock_timeout: parseInt(process.env.PG_LOCK_TIMEOUT_MS ?? "", 10) || 10_000,
          idle_in_transaction_session_timeout:
            parseInt(process.env.PG_IDLE_TX_TIMEOUT_MS ?? "", 10) || 60_000,
        },
        // W42 (PLT-14): verify certs by default; PG_TLS_CA provides a
        // private-CA bundle, PG_TLS_REJECT_UNAUTHORIZED=false is the loud
        // dev-only escape hatch (docs/TLS.md).
        ssl: connStr!.includes("sslmode=require") ? buildTlsOptions("Postgres", "PG") : undefined,
        transform: { undefined: null },
      });
      _db = drizzle(_client);
      __currentDb.db = _db;
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── W42 (PLT-17): bounded retry queue + leak-free client swap ───────────────
// postgres.js queues pending queries internally with NO depth limit; under a
// slow-query pile-up requests queue until client timeout, masked as 5xx. We
// bound the ops that go through withRetry(): when the in-flight/queued count
// exceeds PG_POOL_QUEUE_MAX (default 4× pool max, floor 25) the operation is
// rejected immediately with `db_pool_queue_saturated` instead of hanging.
let _queuedOps = 0;
let _poolResets = 0;

function poolQueueMax(): number {
  const explicit = parseInt(process.env.PG_POOL_QUEUE_MAX ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const poolMax = parseInt(process.env.PG_POOL_MAX ?? "", 10);
  return Math.max((Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10) * 4, 25);
}

/** Diagnostics/health: current number of ops inside withRetry(). */
export function getDbQueueDepth(): number {
  return _queuedOps;
}

/** Diagnostics/health: configured queue bound. */
export function getDbQueueMax(): number {
  return poolQueueMax();
}

/** Diagnostics: how many times a live pool was ended+swapped (leak guard). */
export function getDbPoolResetCount(): number {
  return _poolResets;
}

/**
 * Swap the pooled client without leaking it: end the OLD client's sockets
 * before clearing references. Previously withRetry() nulled `_db`/`_client`
 * and dropped the old pool on the floor — its connections stayed open until
 * PG/server reaped them, leaking sockets under error bursts.
 */
export async function resetDbConnection(reason = "unspecified"): Promise<void> {
  const oldClient = _client;
  _db = null;
  _client = null;
  if (oldClient) {
    _poolResets++; // pinned by J319: a swap must END the old pool, not drop it
    try {
      // Bounded wait — a wedged pool must not hang the retry loop forever.
      await Promise.race([
        oldClient.end({ timeout: 5 }),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch (err: any) {
      console.warn(`[DB] Failed to end old pool during reset (${reason}):`, err?.message ?? err);
    }
  }
}

/**
 * Execute a DB operation with exponential backoff retry.
 * Retries up to 3 times on transient connection errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 200
): Promise<T> {
  // W42 (PLT-17): shed load instead of queueing unboundedly behind a
  // saturated pool. This is NOT a connection limit (postgres.js `max` already
  // bounds connections) — it bounds *queued work* so a pile-up fails fast.
  if (_queuedOps >= poolQueueMax()) {
    const err = new Error(
      `db_pool_queue_saturated: ${_queuedOps}/${poolQueueMax()} ops in flight — rejecting instead of queueing`
    ) as Error & { code: string; statusCode: number };
    err.code = "DB_POOL_QUEUE_SATURATED";
    err.statusCode = 503;
    throw err;
  }
  _queuedOps++;
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const isTransient =
          err?.code === "ECONNRESET" ||
          err?.code === "ECONNREFUSED" ||
          err?.code === "ETIMEDOUT" ||
          err?.message?.includes("connection") ||
          err?.message?.includes("timeout");
        if (!isTransient || attempt === retries - 1) throw err;
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 50;
        console.warn(`[DB] Transient error (attempt ${attempt + 1}/${retries}), retrying in ${Math.round(delay)}ms:`, err?.message);
        await new Promise(r => setTimeout(r, delay));
        // W42 (PLT-17): end the old pool's sockets BEFORE swapping references
        // — previously the old client was dropped un-ended and leaked.
        await resetDbConnection("transient-error-retry");
      }
    }
    throw lastErr;
  } finally {
    _queuedOps--;
  }
}

// ─── User Helpers ─────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  textFields.forEach((f) => {
    const v = user[f];
    if (v !== undefined) { values[f] = v ?? null; updateSet[f] = v ?? null; }
  });
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === (process.env.OWNER_OPEN_ID ?? "")) { values.role = "admin"; updateSet.role = "admin"; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  // PostgreSQL upsert
  await db.insert(users).values(values).onConflictDoUpdate({
    target: users.openId,
    set: updateSet,
  });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

// ─── Tenant Helpers ───────────────────────────────────────────────────────────

export async function getTenants(limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tenants).orderBy(desc(tenants.createdAt)).limit(limit).offset(offset);
}

export async function getTenantById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return r[0];
}

export async function createTenant(data: InsertTenant) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.insert(tenants).values(data);
  return data;
}

export async function updateTenant(id: string, data: Partial<InsertTenant>) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(tenants).set(data).where(eq(tenants.id, id));
}

export async function getTenantStats() {
  const db = await getDb();
  if (!db) return { total: 0, active: 0, trial: 0, suspended: 0 };
  const [total, active, trial, suspended] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(tenants),
    db.select({ count: sql<number>`count(*)` }).from(tenants).where(eq(tenants.status, "active")),
    db.select({ count: sql<number>`count(*)` }).from(tenants).where(eq(tenants.status, "trial")),
    db.select({ count: sql<number>`count(*)` }).from(tenants).where(eq(tenants.status, "suspended")),
  ]);
  return {
    total: Number(total[0]?.count ?? 0),
    active: Number(active[0]?.count ?? 0),
    trial: Number(trial[0]?.count ?? 0),
    suspended: Number(suspended[0]?.count ?? 0),
  };
}

// ─── Product Helpers ──────────────────────────────────────────────────────────

export async function getProducts(tenantId: string, limit = 50, offset = 0, search?: string) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(products.tenantId, tenantId)];
  if (search) conditions.push(like(products.name, `%${search}%`));
  return db.select().from(products).where(and(...conditions)).orderBy(desc(products.createdAt)).limit(limit).offset(offset);
}

export async function createProduct(data: InsertProduct) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.insert(products).values(data);
  return data;
}

export async function updateProduct(id: string, tenantId: string, data: Partial<InsertProduct>) {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(products).set(data).where(and(eq(products.id, id), eq(products.tenantId, tenantId)));
}

export async function getProductStats(tenantId: string) {
  const db = await getDb();
  if (!db) return { total: 0, active: 0, lowStock: 0 };
  const [total, active, lowStock] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(products).where(eq(products.tenantId, tenantId)),
    db.select({ count: sql<number>`count(*)` }).from(products).where(and(eq(products.tenantId, tenantId), eq(products.status, "active"))),
    db.select({ count: sql<number>`count(*)` }).from(products).where(and(eq(products.tenantId, tenantId), sql`"stockQuantity" <= "lowStockThreshold"`)),
  ]);
  return {
    total: Number(total[0]?.count ?? 0),
    active: Number(active[0]?.count ?? 0),
    lowStock: Number(lowStock[0]?.count ?? 0),
  };
}

// ─── Customer Helpers ─────────────────────────────────────────────────────────

export async function getCustomers(tenantId: string, limit = 50, offset = 0, search?: string) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(customers.tenantId, tenantId)];
  if (search) conditions.push(like(customers.name, `%${search}%`));
  return db.select().from(customers).where(and(...conditions)).orderBy(desc(customers.createdAt)).limit(limit).offset(offset);
}

export async function getCustomerCount(tenantId: string) {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sql<number>`count(*)` }).from(customers).where(eq(customers.tenantId, tenantId));
  return Number(r[0]?.count ?? 0);
}

// ─── Conversation Helpers ─────────────────────────────────────────────────────

export async function getConversations(tenantId: string, status?: string, limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(conversations.tenantId, tenantId)];
  if (status) conditions.push(eq(conversations.status, status as any));
  const rows = await db
    .select({
      id: conversations.id,
      tenantId: conversations.tenantId,
      customerId: conversations.customerId,
      chatwootConversationId: conversations.chatwootConversationId,
      status: conversations.status,
      channel: conversations.channel,
      assignedAgentId: conversations.assignedAgentId,
      currentFlowStep: conversations.currentFlowStep,
      lastIntent: conversations.lastIntent,
      cartId: conversations.cartId,
      messageCount: conversations.messageCount,
      aiHandled: conversations.aiHandled,
      escalatedAt: conversations.escalatedAt,
      resolvedAt: conversations.resolvedAt,
      firstResponseAt: conversations.firstResponseAt,
      metadata: conversations.metadata,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      customerPhone: customers.whatsappPhone,
      customerName: customers.name,
    })
    .from(conversations)
    .leftJoin(customers, eq(conversations.customerId, customers.id))
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows;
}

export async function getConversationStats(tenantId: string) {
  const db = await getDb();
  if (!db) return { total: 0, open: 0, botActive: 0, humanActive: 0, resolved: 0, escalated: 0 };
  const [total, open, botActive, humanActive, resolved, escalated] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(eq(conversations.tenantId, tenantId)),
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.status, "open"))),
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.status, "bot_active"))),
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.status, "human_active"))),
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.status, "resolved"))),
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(and(eq(conversations.tenantId, tenantId), sql`"escalatedAt" IS NOT NULL`)),
  ]);
  return {
    total: Number(total[0]?.count ?? 0),
    open: Number(open[0]?.count ?? 0),
    botActive: Number(botActive[0]?.count ?? 0),
    humanActive: Number(humanActive[0]?.count ?? 0),
    resolved: Number(resolved[0]?.count ?? 0),
    escalated: Number(escalated[0]?.count ?? 0),
  };
}

// ─── Order Helpers ────────────────────────────────────────────────────────────

export async function getOrders(tenantId: string, status?: string, limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(orders.tenantId, tenantId)];
  if (status) conditions.push(eq(orders.status, status as any));
  return db.select().from(orders).where(and(...conditions)).orderBy(desc(orders.createdAt)).limit(limit).offset(offset);
}

export async function getOrderStats(tenantId: string) {
  const db = await getDb();
  if (!db) return { total: 0, pending: 0, confirmed: 0, delivered: 0, revenue: 0 };
  const [total, pending, confirmed, delivered, revenue] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(orders).where(eq(orders.tenantId, tenantId)),
    db.select({ count: sql<number>`count(*)` }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.status, "pending"))),
    db.select({ count: sql<number>`count(*)` }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.status, "confirmed"))),
    db.select({ count: sql<number>`count(*)` }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.status, "delivered"))),
    db.select({ total: sql<number>`COALESCE(SUM("totalAmount"), 0)` }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.paymentStatus, "completed"))),
  ]);
  return {
    total: Number(total[0]?.count ?? 0),
    pending: Number(pending[0]?.count ?? 0),
    confirmed: Number(confirmed[0]?.count ?? 0),
    delivered: Number(delivered[0]?.count ?? 0),
    revenue: Number(revenue[0]?.total ?? 0),
  };
}

// ─── Payment Helpers ──────────────────────────────────────────────────────────

export async function getPaymentIntents(tenantId: string, status?: string, limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(paymentIntents.tenantId, tenantId)];
  if (status) conditions.push(eq(paymentIntents.status, status as any));
  return db.select().from(paymentIntents).where(and(...conditions)).orderBy(desc(paymentIntents.createdAt)).limit(limit).offset(offset);
}

// ─── Agent Event Helpers ──────────────────────────────────────────────────────

export async function insertAgentEvent(data: InsertAgentEvent) {
  const db = await getDb();
  if (!db) return;
  await db.insert(agentEvents).values(data);
}

export async function getAgentStats(tenantId: string) {
  const db = await getDb();
  if (!db) return { total: 0, escalated: 0, avgLatency: 0, avgConfidence: 0 };
  const [total, escalated, perf] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(agentEvents).where(eq(agentEvents.tenantId, tenantId)),
    db.select({ count: sql<number>`count(*)` }).from(agentEvents).where(and(eq(agentEvents.tenantId, tenantId), eq(agentEvents.escalated, true))),
    db.select({
      avgLatency: sql<number>`COALESCE(AVG("latencyMs"), 0)`,
      avgConfidence: sql<number>`COALESCE(AVG(confidence), 0)`,
    }).from(agentEvents).where(eq(agentEvents.tenantId, tenantId)),
  ]);
  return {
    total: Number(total[0]?.count ?? 0),
    escalated: Number(escalated[0]?.count ?? 0),
    avgLatency: Math.round(Number(perf[0]?.avgLatency ?? 0)),
    avgConfidence: Number(perf[0]?.avgConfidence ?? 0),
  };
}

// ─── Service Health Helpers ───────────────────────────────────────────────────

export async function getServiceHealth() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(serviceHealth).orderBy(serviceHealth.serviceName);
}

export async function upsertServiceHealth(serviceName: string, status: string, latencyMs?: number, errorRate?: number, details?: unknown) {
  const db = await getDb();
  if (!db) return;
  await db.insert(serviceHealth).values({
    serviceName,
    status: status as any,
    latencyMs,
    errorRate: errorRate?.toString() as any,
    lastCheckedAt: new Date(),
    details: details as any,
  }).onConflictDoUpdate({
    target: serviceHealth.serviceName,
    set: { status: status as any, latencyMs, errorRate: errorRate?.toString() as any, lastCheckedAt: new Date(), details: details as any },
  });
}

// ─── Dashboard Analytics ──────────────────────────────────────────────────────

export async function getPlatformOverview() {
  const db = await getDb();
  if (!db) return null;
  const [tenantStats, orderRevenue, convCount, agentCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)`, active: sql<number>`SUM(CASE WHEN status='active' THEN 1 ELSE 0 END)` }).from(tenants),
    db.select({ revenue: sql<number>`COALESCE(SUM("totalAmount"), 0)`, count: sql<number>`count(*)` }).from(orders).where(eq(orders.paymentStatus, "completed")),
    db.select({ count: sql<number>`count(*)` }).from(conversations),
    db.select({ count: sql<number>`count(*)` }).from(agentEvents),
  ]);
  return {
    tenants: { total: Number(tenantStats[0]?.count ?? 0), active: Number(tenantStats[0]?.active ?? 0) },
    revenue: Number(orderRevenue[0]?.revenue ?? 0),
    orders: Number(orderRevenue[0]?.count ?? 0),
    conversations: Number(convCount[0]?.count ?? 0),
    agentInteractions: Number(agentCount[0]?.count ?? 0),
  };
}
