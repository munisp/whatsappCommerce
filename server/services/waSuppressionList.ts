// === W45 messaging-services (Coder A2) ===
/**
 * waSuppressionList.ts — per-tenant WhatsApp recipient suppression list
 * (MSG-10).
 *
 * Delivery receipts and send errors with permanent, recipient-level Meta
 * error codes (see WA_SUPPRESS_ERROR_CODES) mean the number can never (or
 * should never again) receive our messages — blocked us, not a WhatsApp
 * user, spam-flagged. Without a suppression list every broadcast, cart
 * recovery nudge and send retry keeps hammering those numbers, burning
 * quality rating and money.
 *
 * Storage: PG table `wa_suppression_list` (durable backing, migration 0148)
 * + Redis set `wa:suppress:{tenantId}` (fast consult path) with an
 * in-memory fallback in dev/test (mirrors cartRecovery.ts marker pattern).
 * The Redis set is a cache — it is re-warmed from PG on a miss, so a Redis
 * flush never un-suppresses a number.
 *
 * All functions are fail-soft: a store error logs and degrades to
 * "not suppressed" for reads (never block legitimate sends on an
 * infrastructure hiccup) and to a dropped write (the next failed receipt
 * re-suppresses).
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { waSuppressionList } from "../../drizzle/schema";
import { getRedis } from "../redis";
import { isProd } from "../_core/env";
import { normalizeWaPhone } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Permanent, recipient-level Meta error codes that justify suppression.
 *  - 131026 message undeliverable (recipient not on WhatsApp / cannot receive)
 *  - 131048 spam rate limit hit (recipient-level engagement lock)
 *  - 131049 per-recipient marketing-message restriction
 *  - 131051/131052/131053 recipient cannot accept this message (unsupported /
 *    blocked category)
 * Tenant/account-level codes (131042 billing, 131047 window, auth codes) are
 * NOT suppression signals — they are handled by the ban circuit breaker.
 */
export const WA_SUPPRESS_ERROR_CODES: ReadonlySet<number> = new Set([
  131026, 131048, 131049, 131051, 131052, 131053,
]);

/** True when any of the given Meta error codes is a suppression signal. */
export function hasSuppressionCode(codes: Array<number | string | undefined | null>): boolean {
  return codes.some((c) => c != null && WA_SUPPRESS_ERROR_CODES.has(Number(c)));
}

// ── Cache layer (Redis set + in-memory fallback) ────────────────────────────

const memorySets = new Map<string, Set<string>>();

function cacheKey(tenantId: string): string {
  return `wa:suppress:${tenantId}`;
}

/** Test helper: wipe the in-memory fallback. */
export function __clearSuppressionMemory(): void {
  memorySets.clear();
}

async function cacheAdd(tenantId: string, phone: string): Promise<void> {
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.sadd(cacheKey(tenantId), phone);
      return;
    }
  } catch { /* fall through */ }
  if (isProd) return;
  const set = memorySets.get(tenantId) ?? new Set<string>();
  set.add(phone);
  memorySets.set(tenantId, set);
}

async function cacheHas(tenantId: string, phone: string): Promise<boolean | null> {
  // null = cache unavailable → caller must consult PG.
  try {
    const redis = await getRedis();
    if (redis) {
      const hit = await redis.sismember(cacheKey(tenantId), phone);
      if (hit === 1) return true;
      // A 0 is only trustworthy when the set EXISTS; an absent key could be a
      // flushed cache. Warm misses are resolved by the caller via PG.
      const exists = await redis.exists(cacheKey(tenantId));
      return exists ? false : null;
    }
  } catch { /* fall through */ }
  if (isProd) return null;
  const set = memorySets.get(tenantId);
  return set ? set.has(phone) : null;
}

async function cacheWarm(tenantId: string, phones: string[]): Promise<void> {
  if (phones.length === 0) return;
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.sadd(cacheKey(tenantId), ...phones);
      return;
    }
  } catch { /* fall through */ }
  if (isProd) return;
  const set = memorySets.get(tenantId) ?? new Set<string>();
  for (const p of phones) set.add(p);
  memorySets.set(tenantId, set);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Add a phone to the tenant's suppression list. Idempotent (unique index +
 * ON CONFLICT DO NOTHING). Returns true when the row is present afterwards
 * (inserted or already existed); false when the write failed.
 */
export async function addToSuppressionList(
  db: Db,
  tenantId: string,
  phone: string,
  opts?: { reasonCode?: string | number | null; source?: string },
): Promise<boolean> {
  const normalized = normalizeWaPhone(phone ?? "");
  if (!tenantId || !normalized) return false;
  try {
    await db
      .insert(waSuppressionList)
      .values({
        tenantId,
        phone: normalized,
        reasonCode: opts?.reasonCode != null ? String(opts.reasonCode).slice(0, 16) : null,
        source: (opts?.source ?? "delivery_receipt").slice(0, 32),
      })
      .onConflictDoNothing();
  } catch (e: any) {
    console.warn("[waSuppression] insert failed:", e?.message);
    return false;
  }
  await cacheAdd(tenantId, normalized);
  return true;
}

/**
 * Inspect Meta `errors[]` entries from a failed delivery receipt / send
 * response and suppress the recipient when a permanent recipient-level code
 * is present. Returns true when a suppression was recorded.
 */
export async function recordSuppressionSignal(
  db: Db,
  tenantId: string,
  phone: string,
  errors: Array<{ code?: unknown }> | undefined | null,
  source: string = "delivery_receipt",
): Promise<boolean> {
  const codes = (errors ?? []).map((e) => (e?.code != null ? Number(e.code) : NaN)).filter((n) => Number.isFinite(n));
  if (!hasSuppressionCode(codes)) return false;
  const first = codes.find((c) => WA_SUPPRESS_ERROR_CODES.has(c));
  return addToSuppressionList(db, tenantId, phone, { reasonCode: first, source });
}

/** True when the phone is on the tenant's suppression list. Fail-soft. */
export async function isSuppressed(db: Db, tenantId: string, phone: string): Promise<boolean> {
  const normalized = normalizeWaPhone(phone ?? "");
  if (!tenantId || !normalized) return false;
  const cached = await cacheHas(tenantId, normalized);
  if (cached === true) return true;
  try {
    const [row] = await db
      .select({ id: waSuppressionList.id })
      .from(waSuppressionList)
      .where(and(eq(waSuppressionList.tenantId, tenantId), eq(waSuppressionList.phone, normalized)))
      .limit(1);
    if (row) {
      await cacheAdd(tenantId, normalized);
      return true;
    }
  } catch (e: any) {
    console.warn("[waSuppression] lookup failed (fail-open):", e?.message);
  }
  return false;
}

/**
 * Full suppressed-phone set for a tenant — used by the broadcast audience
 * builder to exclude suppressed numbers in one pass. Fail-soft (empty set).
 */
export async function getSuppressedPhones(db: Db, tenantId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = await db
      .select({ phone: waSuppressionList.phone })
      .from(waSuppressionList)
      .where(eq(waSuppressionList.tenantId, tenantId))
      .catch(() => [] as any[]);
    for (const r of rows ?? []) {
      const p = normalizeWaPhone(String(r?.phone ?? ""));
      if (p) out.add(p);
    }
    await cacheWarm(tenantId, Array.from(out));
  } catch (e: any) {
    console.warn("[waSuppression] set lookup failed (fail-open):", e?.message);
  }
  return out;
}

/**
 * Remove a phone from the suppression list (e.g. the customer messages in
 * from a ported number / ops override). Best-effort; returns success.
 */
export async function removeFromSuppressionList(db: Db, tenantId: string, phone: string): Promise<boolean> {
  const normalized = normalizeWaPhone(phone ?? "");
  if (!tenantId || !normalized) return false;
  try {
    await db
      .delete(waSuppressionList)
      .where(and(eq(waSuppressionList.tenantId, tenantId), eq(waSuppressionList.phone, normalized)));
  } catch (e: any) {
    console.warn("[waSuppression] delete failed:", e?.message);
    return false;
  }
  try {
    const redis = await getRedis();
    if (redis) await redis.srem(cacheKey(tenantId), normalized);
    else if (!isProd) memorySets.get(tenantId)?.delete(normalized);
  } catch { /* ignore */ }
  return true;
}

/** Count helper for ops dashboards. Fail-soft (0). */
export async function countSuppressed(db: Db, tenantId: string): Promise<number> {
  try {
    const res: any = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM wa_suppression_list WHERE tenant_id = ${tenantId}`,
    );
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    return Number(rows[0]?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}
