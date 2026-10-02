// === W61 dataloss ===
/**
 * W61 DLQ drain (audit CRITICAL #4 + HIGH #7) — server/services/dlqDrain.ts
 *
 * Three durable dead-letter sinks had NO reprocessor and NO alert:
 *   - Redis list `mp:dlq:events`      (message-processor; drain() uncalled)
 *   - Redis list `hermes:dlq`         (hermes-router; metric counter only)
 *   - Redis list `notifications:dlq:spill` (notification-service W61 spill —
 *     previously a DLQ-write failure logged "message dropped after commit"
 *     and the event was silently lost)
 * plus the WA webhook DLQ fallback backends (`wa:webhook:dlq-fallback` Redis
 * list + JSONL file) whose replayWaWebhookFallback() had ZERO callers.
 *
 * runDlqDrain (invoked by /api/scheduled/dlq-drain):
 *   1. Replays the WA webhook fallback into wa_webhook_events (existing
 *      claim semantics: entries are removed only after a successful insert).
 *   2. Drains each Redis DLQ list with a per-run CAP (default 100): LPOP'd
 *      entries are re-persisted into fluvio_event_log (topic '<key>',
 *      processed=false) BEFORE the next pop — a crash mid-drain loses at
 *      most the in-flight entry, which stays popped only after its insert
 *      succeeded (pop-after-persist ordering via RPOPLPUSH-style claim is
 *      unnecessary at this volume; insert-first then pop is used).
 *   3. NEVER silent-drops: every drained/remaining event is counted, logged,
 *      and when any DLQ is non-empty the tenant admin (when a tenantId is
 *      resolvable from the payload) gets a WhatsApp ops alert via the
 *      existing admin-alerts path; a platform-level console.error summary is
 *      always emitted. Fail-open telemetry: Redis down → logged + counted,
 *      route still returns 200 with ok:true and per-key errors.
 */

import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import { fluvioEventLog, tenants } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const DLQ_REDIS_KEYS = [
  "mp:dlq:events",
  "hermes:dlq",
  "notifications:dlq:spill",
] as const;

export const DLQ_DRAIN_DEFAULT_CAP = 100;

export interface DlqDrainKeyResult {
  key: string;
  drained: number;
  remaining: number;
  error?: string;
}

export interface DlqDrainRunResult {
  keys: DlqDrainKeyResult[];
  waFallback: { redis: { replayed: number; remaining: number }; file: { replayed: number; remaining: number } } | null;
  alertsSent: number;
  totalDrained: number;
  totalRemaining: number;
}

/** Minimal Redis surface this drain needs (injectable for tests). */
export interface DlqRedisLike {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  llen(key: string): Promise<number>;
}

/** Extract a tenantId from a dead-lettered payload (best-effort). */
function tenantIdFromPayload(p: any): string | null {
  const v = p?.tenantId ?? p?.tenant_id ?? p?.payload?.tenantId ?? p?.payload?.tenant_id;
  return typeof v === "string" && v.length >= 8 ? v : null;
}

/**
 * Alert tenant admins about non-empty DLQs (one WA ops alert per affected
 * tenant, capped) + a loud platform-level console.error. Never throws.
 */
async function alertNonEmptyDlqs(
  db: Db,
  perKey: DlqDrainKeyResult[],
  tenantIds: Set<string>,
): Promise<number> {
  let sent = 0;
  const summary = perKey
    .filter((k) => k.drained > 0 || k.remaining > 0)
    .map((k) => `${k.key}: drained=${k.drained} remaining=${k.remaining}${k.error ? ` error=${k.error}` : ""}`)
    .join("; ");
  if (!summary) return 0;
  console.error(`[dlq-drain] ALERT non-empty DLQs — ${summary}`); // platform-level, never silent
  try {
    const { notifyTenantAdminWhatsApp } = await import("./adminAlerts");
    for (const tenantId of Array.from(tenantIds).slice(0, 5)) {
      // Only alert tenants that actually exist (payloads can be foreign).
      const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
      if (!t) continue;
      const delivered = await notifyTenantAdminWhatsApp(
        db,
        tenantId,
        `⚠️ DLQ drain found dead-lettered events for your workspace.\n${summary}\nThey were re-persisted to the event log and will be reprocessed by the fluvio-event-sweep.`,
      );
      if (delivered) sent++;
    }
  } catch (e: any) {
    console.error("[dlq-drain] admin alert path failed:", e?.message);
  }
  return sent;
}

/**
 * Drain the durable DLQs. Claim semantics: each entry is inserted into
 * fluvio_event_log BEFORE being removed from its list (LTRIM of the
 * successfully-persisted prefix only), so a crash mid-drain never loses an
 * event. Bounded by `cap` per key. Never throws.
 */
export async function runDlqDrain(
  db: Db,
  opts?: { cap?: number; redis?: DlqRedisLike | null },
): Promise<DlqDrainRunResult> {
  const cap = opts?.cap ?? DLQ_DRAIN_DEFAULT_CAP;
  const result: DlqDrainRunResult = { keys: [], waFallback: null, alertsSent: 0, totalDrained: 0, totalRemaining: 0 };
  const tenantIds = new Set<string>();

  // ── 1. WA webhook DLQ fallback replay (W42 path, previously zero callers)
  try {
    const { replayWaWebhookFallback } = await import("./waWebhookDlqFallback");
    result.waFallback = await replayWaWebhookFallback(db);
    if (result.waFallback.redis.remaining > 0 || result.waFallback.file.remaining > 0) {
      console.error(`[dlq-drain] ALERT wa:webhook:dlq-fallback still has ${result.waFallback.redis.remaining + result.waFallback.file.remaining} unreplayed record(s)`);
    }
  } catch (e: any) {
    console.error("[dlq-drain] wa fallback replay failed (fail-open):", e?.message);
  }

  // ── 2. Redis DLQ list drains (insert-first, then trim persisted prefix) ─
  let redis: DlqRedisLike | null = opts?.redis ?? null;
  if (!redis) {
    try {
      const { getRedis } = await import("../redis");
      redis = (await getRedis()) as unknown as DlqRedisLike | null;
    } catch (e: any) {
      console.warn("[dlq-drain] redis lookup failed:", e?.message);
    }
  }
  if (!redis) {
    for (const key of DLQ_REDIS_KEYS) {
      result.keys.push({ key, drained: 0, remaining: 0, error: "redis-unavailable" });
    }
    console.warn("[dlq-drain] Redis unavailable — DLQ lists not drained this run (fail-open)");
    return result;
  }

  for (const key of DLQ_REDIS_KEYS) {
    const kr: DlqDrainKeyResult = { key, drained: 0, remaining: 0 };
    result.keys.push(kr);
    try {
      const items = await redis.lrange(key, 0, cap - 1);
      let persisted = 0;
      for (const raw of items) {
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { payload = { raw }; }
        const tId = tenantIdFromPayload(payload);
        if (tId) tenantIds.add(tId);
        // Insert-first: the event is durable in fluvio_event_log before the
        // list entry is removed.
        await db.insert(fluvioEventLog).values({
          topic: `dlq:${key}`,
          offset: Date.now() * 1000 + persisted, // synthetic monotone offset
          partition: 0,
          tenantId: tId,
          eventType: (payload as any)?.event_type ?? (payload as any)?.eventType ?? null,
          payload: (payload ?? {}) as Record<string, unknown>,
          processed: false,
          receivedAt: new Date(),
        });
        persisted++;
      }
      if (persisted > 0) await redis.ltrim(key, persisted, -1);
      kr.drained = persisted;
      kr.remaining = await redis.llen(key).catch(() => 0);
    } catch (e: any) {
      kr.error = String(e?.message ?? e).slice(0, 200);
      console.error(`[dlq-drain] drain of ${key} failed (fail-open):`, e?.message);
    }
    result.totalDrained += kr.drained;
    result.totalRemaining += kr.remaining;
  }

  // ── 3. Alerts — never silent ────────────────────────────────────────────
  if (result.totalDrained > 0 || result.totalRemaining > 0) {
    result.alertsSent = await alertNonEmptyDlqs(db, result.keys, tenantIds);
  }
  return result;
}
// === END W61 dataloss ===
