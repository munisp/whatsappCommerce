/**
 * Usage metering + plan quotas.
 *
 * Counters live in `usage_counters` (migration 0039), keyed by
 * (tenantId, metric, period) where period is "yyyymm" (UTC). `recordUsage`
 * upsert-increments atomically (INSERT … ON CONFLICT DO UPDATE SET count =
 * count + n) so concurrent webhook processing never loses an increment.
 *
 * Plan limits live in tenants.settings.plan = { tier, limits: {
 * messagesPerMonth, ordersPerMonth } } with DEFAULT_PLAN as the fallback.
 *
 * Quota policy (enforced at the WhatsApp webhook dispatch layer):
 *   - ≥80% of the monthly message limit  → one warning to the tenant
 *     adminPhone per period (Redis-deduped, in-memory fallback in dev/test);
 *   - ≥100%                               → one "limit reached" warning;
 *   - ≥110% (hard limit + 10% grace)      → the buyer gets a polite
 *     "merchant busy" reply and the message is NOT processed.
 *
 * Metering is additive and never throws into the caller's business path:
 * a metering failure is logged and swallowed (usage stats must never block
 * payments or messages); only the quota gate can affect message flow.
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants, usageCounters } from "../../drizzle/schema";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { sendWhatsAppText } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ── Metrics ──────────────────────────────────────────────────────────────────
export const METRIC_MESSAGES_IN = "messages_in";
export const METRIC_MESSAGES_OUT = "messages_out";
export const METRIC_ORDERS_CREATED = "orders_created";
/** Combined message counter the monthly messagesPerMonth quota gates on. */
export const METRIC_MESSAGES = "messages";

// ── Plans ────────────────────────────────────────────────────────────────────
export interface PlanLimits {
  messagesPerMonth: number;
  ordersPerMonth: number;
}
export interface TenantPlan {
  tier: string;
  limits: PlanLimits;
}

export const DEFAULT_PLAN: TenantPlan = {
  tier: "starter",
  limits: { messagesPerMonth: 1000, ordersPerMonth: 500 },
};

/** Hard-stop grace: traffic up to 110% of the limit is allowed (with warnings). */
export const QUOTA_GRACE_RATIO = 1.1;
/** First warning threshold. */
export const QUOTA_WARN_RATIO = 0.8;

/** Current UTC metering period, "yyyymm". */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Counter primitives ───────────────────────────────────────────────────────

/**
 * Increment a tenant's counter for the current period. Returns the new count,
 * or null when the increment could not be persisted (table missing / DB
 * error) — callers treat null as "metering unavailable", never as zero usage.
 */
export async function recordUsage(
  db: Db,
  tenantId: string,
  metric: string,
  n: number = 1,
  period: string = currentPeriod(),
): Promise<number | null> {
  try {
    const rows = await db
      .insert(usageCounters)
      .values({ tenantId, metric, period, count: n, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [usageCounters.tenantId, usageCounters.metric, usageCounters.period],
        set: { count: sql`${usageCounters.count} + ${n}`, updatedAt: new Date() },
      })
      .returning({ count: usageCounters.count });
    return rows[0]?.count ?? null;
  } catch (err: any) {
    console.error(`[metering] recordUsage failed (${tenantId}/${metric}/${period}):`, err?.message);
    return null;
  }
}

/** Read a single counter (0 when absent). */
export async function getUsageCount(
  db: Db,
  tenantId: string,
  metric: string,
  period: string = currentPeriod(),
): Promise<number> {
  const [row] = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(and(
      eq(usageCounters.tenantId, tenantId),
      eq(usageCounters.metric, metric),
      eq(usageCounters.period, period),
    ))
    .limit(1);
  return row?.count ?? 0;
}

/** All counters for a tenant in a period. */
export async function getUsage(
  db: Db,
  tenantId: string,
  period: string = currentPeriod(),
): Promise<Array<{ metric: string; period: string; count: number }>> {
  const rows = await db
    .select({ metric: usageCounters.metric, period: usageCounters.period, count: usageCounters.count })
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.period, period)));
  return rows;
}

// ── Plans ────────────────────────────────────────────────────────────────────

/** Resolve the tenant's plan from tenants.settings.plan, defaulting safely. */
export async function getPlan(db: Db, tenantId: string): Promise<TenantPlan> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  const raw = (tenant?.settings as any)?.plan;
  const limits = raw?.limits ?? {};
  return {
    tier: typeof raw?.tier === "string" && raw.tier ? raw.tier : DEFAULT_PLAN.tier,
    limits: {
      messagesPerMonth: Number.isFinite(limits.messagesPerMonth)
        ? Number(limits.messagesPerMonth) : DEFAULT_PLAN.limits.messagesPerMonth,
      ordersPerMonth: Number.isFinite(limits.ordersPerMonth)
        ? Number(limits.ordersPerMonth) : DEFAULT_PLAN.limits.ordersPerMonth,
    },
  };
}

/** Persist a plan into tenants.settings.plan (additive merge into settings). */
export async function setPlan(db: Db, tenantId: string, plan: TenantPlan): Promise<void> {
  await db.update(tenants).set({
    settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({ plan })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(tenants.id, tenantId));
}

// ── Quota gate ───────────────────────────────────────────────────────────────

export interface QuotaDecision {
  /** False only past the hard limit (limit × QUOTA_GRACE_RATIO). */
  allowed: boolean;
  usage: number;
  limit: number;
  period: string;
  /** Crossed thresholds that should trigger an admin warning. */
  warnLevel: 80 | 100 | null;
  /** True when usage is at/above the hard stop (allowed === false). */
  hardStopped: boolean;
  /** True when metering was unavailable and the gate degraded open. */
  degraded: boolean;
}

// Dev/test fallback for the per-period admin-warning dedupe when Redis is
// unavailable. Production without Redis logs an error and may re-warn (a
// duplicate warning is far safer than blocking traffic).
const memoryWarnLedger = new Set<string>();

/**
 * Returns true the FIRST time this (tenant, metric, period, level) warning is
 * raised; false on repeats within the period.
 */
export async function claimQuotaWarning(
  tenantId: string,
  metric: string,
  period: string,
  level: 80 | 100,
): Promise<boolean> {
  const key = `quota-warn:${tenantId}:${metric}:${period}:${level}`;
  try {
    const redis = await getRedis();
    if (redis) {
      // 40-day TTL comfortably covers the monthly period.
      const res = await redis.set(key, "1", "EX", 40 * 24 * 3600, "NX");
      return res === "OK";
    }
    if (isProd) {
      console.error("[metering] Redis unavailable in production — quota warning dedupe degraded (may re-warn)");
      return true;
    }
  } catch (err: any) {
    if (isProd) {
      console.error("[metering] quota warning dedupe failed:", err?.message);
      return true;
    }
  }
  // Dev/test in-memory fallback.
  if (memoryWarnLedger.has(key)) return false;
  memoryWarnLedger.add(key);
  return true;
}

/**
 * Record one unit of a gated metric and decide whether the traffic may
 * proceed. `usage` comes from recordUsage; when metering is unavailable
 * (null) the gate degrades OPEN (degraded=true) — usage stats must never
 * block message flow.
 */
export function evaluateQuota(usage: number | null, limit: number, period: string = currentPeriod()): QuotaDecision {
  if (usage == null) {
    return { allowed: true, usage: 0, limit, period, warnLevel: null, hardStopped: false, degraded: true };
  }
  const hardLimit = Math.floor(limit * QUOTA_GRACE_RATIO);
  const warnLevel: 80 | 100 | null =
    usage >= limit ? 100 : usage >= Math.floor(limit * QUOTA_WARN_RATIO) ? 80 : null;
  const hardStopped = usage > hardLimit;
  return { allowed: !hardStopped, usage, limit, period, warnLevel, hardStopped, degraded: false };
}

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

/**
 * Send the tenant admin a quota warning — at most once per (metric, period,
 * level) via claimQuotaWarning. Never throws.
 */
export async function notifyQuotaWarning(
  db: Db,
  tenantId: string,
  decision: QuotaDecision,
): Promise<void> {
  if (!decision.warnLevel) return;
  try {
    const first = await claimQuotaWarning(tenantId, METRIC_MESSAGES, decision.period, decision.warnLevel);
    if (!first) return;
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .catch(() => []);
    const adminPhone = adminPhoneFromSettings(tenant?.settings);
    if (!adminPhone) {
      console.warn(`[metering] tenant ${tenantId} at ${decision.warnLevel}% of message quota but no adminPhone configured`);
      return;
    }
    const body = decision.warnLevel === 100
      ? `⚠️ Your WhatsApp commerce plan has REACHED its monthly message limit (${decision.usage}/${decision.limit} for ${decision.period}). ` +
        `Messages keep working up to a 10% grace, then buyers will see a "merchant busy" reply. Upgrade your plan to avoid interruption.`
      : `⚠️ Heads up: your WhatsApp commerce plan is at ${decision.warnLevel}% of its monthly message limit (${decision.usage}/${decision.limit} for ${decision.period}). Consider upgrading soon.`;
    await sendWhatsAppText(tenantId, adminPhone, body, { notifType: "quota_warning" });
  } catch (err: any) {
    console.error("[metering] quota warning notify failed:", err?.message);
  }
}

/** Test helper: reset the in-memory warning dedupe ledger. */
export function __resetQuotaWarnLedgerForTests(): void {
  memoryWarnLedger.clear();
}
