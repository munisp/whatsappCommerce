// === W48 integrations ===
/**
 * waTenantLookup.ts — cached phone_number_id → tenant resolution
 * (PERF-INT-6, also covers the tenant-record half of PERF-INT-9).
 *
 * Every inbound WhatsApp webhook message re-selected the tenant row by
 * `whatsappPhoneNumberId` — the hottest, slowest-changing lookup in the
 * inbound pipeline. Under Meta batch/burst delivery this was the top DB
 * read-amplification contributor.
 *
 * Pattern mirrors the proven i18n locale cache (services/i18n.ts:544-567):
 *   - Redis `setex` read-through (TTL WA_TENANT_LOOKUP_CACHE_TTL_MS, default
 *     300s) so all workers share the warm cache;
 *   - in-process Map fallback when Redis is unavailable (fail-open: a cache
 *     error NEVER blocks the lookup — it falls through to Postgres);
 *   - explicit invalidation via `invalidateWaTenantLookup` on every write to
 *     tenants.whatsappPhoneNumberId (tenant router, onboarding, onboarding
 *     copilot, embedded signup) — overwrite/delete-on-write, same doctrine
 *     as i18n.
 *
 * Cached value is the tenant row shape the inbound pipeline needs
 * (id, status, settings, whatsappPhoneNumberId). `null` (unknown
 * phone_number_id) is cached too — Meta test-button traffic to unknown ids
 * otherwise re-queries Postgres on every delivery.
 */
import { eq } from "drizzle-orm";
import { tenants } from "../../drizzle/schema";
import { getRedis } from "../redis";

export interface WaTenantLookupRow {
  id: string;
  status?: unknown;
  settings?: unknown;
  whatsappPhoneNumberId?: string | null;
  [k: string]: unknown;
}

const TTL_MS = (() => {
  const raw = Number(process.env.WA_TENANT_LOOKUP_CACHE_TTL_MS ?? 300_000);
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  return Math.min(600_000, Math.max(60_000, raw));
})();

const cacheKey = (phoneNumberId: string) => `w48:wa-tenant:${phoneNumberId}`;

// In-proc fallback: phoneNumberId → { row|null, expiresAt }
const memCache = new Map<string, { row: WaTenantLookupRow | null; expiresAt: number }>();

/** Test hook: wipe the in-process cache. */
export function __clearWaTenantLookupCache(): void {
  memCache.clear();
}

/**
 * Resolve the tenant for a WhatsApp phone_number_id. Returns null when no
 * tenant claims the number. Never throws — on any cache error it falls back
 * to a direct DB read.
 */
export async function lookupTenantByPhoneNumberId(
  db: any,
  phoneNumberId: string,
): Promise<WaTenantLookupRow | null> {
  if (!phoneNumberId) return null;

  // 1. In-proc hit (fastest; also the Redis-down fallback).
  const mem = memCache.get(phoneNumberId);
  if (mem && mem.expiresAt > Date.now()) return mem.row;

  // 2. Redis read-through.
  try {
    const redis = await getRedis();
    if (redis) {
      const raw = await redis.get(cacheKey(phoneNumberId));
      if (raw !== null && raw !== undefined) {
        const row = raw === "null" ? null : (JSON.parse(raw) as WaTenantLookupRow);
        memCache.set(phoneNumberId, { row, expiresAt: Date.now() + Math.min(TTL_MS, 60_000) });
        return row;
      }
    }
  } catch { /* cache fail-open */ }

  // 3. Postgres (authoritative).
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.whatsappPhoneNumberId, phoneNumberId))
    .limit(1)
    .catch(() => [null as any]);
  const row = (tenant as WaTenantLookupRow | undefined) ?? null;

  // Populate caches (best-effort).
  memCache.set(phoneNumberId, { row, expiresAt: Date.now() + Math.min(TTL_MS, 60_000) });
  if (memCache.size > 5_000) memCache.clear();
  try {
    const redis = await getRedis();
    if (redis) {
      await redis.setex(cacheKey(phoneNumberId), Math.ceil(TTL_MS / 1000), row === null ? "null" : JSON.stringify(row));
    }
  } catch { /* cache fail-open */ }
  return row;
}

/** Drop cached entries for a phone_number_id after a tenant write. */
export async function invalidateWaTenantLookup(phoneNumberId: string | null | undefined): Promise<void> {
  if (!phoneNumberId) return;
  memCache.delete(phoneNumberId);
  try {
    const redis = await getRedis();
    if (redis) await redis.del(cacheKey(phoneNumberId));
  } catch { /* cache fail-open */ }
}

/** Convenience: invalidate both the old and new ids around a reassignment. */
export async function invalidateWaTenantLookupPair(
  oldPhoneNumberId: string | null | undefined,
  newPhoneNumberId: string | null | undefined,
): Promise<void> {
  await invalidateWaTenantLookup(oldPhoneNumberId);
  if (newPhoneNumberId && newPhoneNumberId !== oldPhoneNumberId) {
    await invalidateWaTenantLookup(newPhoneNumberId);
  }
}
