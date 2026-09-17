/**
 * === W42 (Coder A) PLT-12: WA webhook DLQ-insert durable fallback + ops alert ===
 * The Meta webhook handler (/api/webhooks/whatsapp) persists every inbound
 * payload into wa_webhook_events (the DLQ) BEFORE acking Meta. A failed
 * insert used to be log-only — Meta still got its 200, so the event was gone
 * for good. Now a failed insert:
 *   1. is persisted to a durable fallback — Redis list
 *      `wa:webhook:dlq-fallback` when Redis is up, else an append-only JSONL
 *      file (WA_WEBHOOK_DLQ_FALLBACK_FILE, default
 *      `.wa-webhook-dlq-fallback.jsonl`) that survives process restart;
 *   2. raises an ops alert via the existing admin-alerts path
 *      (notifyTenantAdminWhatsApp) when the tenant can be resolved from the
 *      payload's phone_number_id — otherwise a loud console.error (never
 *      silent).
 * replayWaWebhookFallback() re-inserts fallback records into the DLQ table
 * once the DB is healthy again (dead-letter replay path; used by the sweeps
 * and J310/J311 journeys).
 */

import { appendFile, readFile, writeFile } from "fs/promises";
import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants, waWebhookEvents } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface WaWebhookDlqRecord {
  id: string;
  messageId: string | null;
  phoneNumberId: string | null;
  waPhoneNumber: string | null;
  messageType: string | null;
  rawPayload: unknown;
  status: string;
  retryCount: number;
  /** W42: marks records that came through the fallback path. */
  fallbackReason?: string;
  fallbackAt?: string;
}

export const WA_DLQ_FALLBACK_REDIS_KEY = "wa:webhook:dlq-fallback";
const DEFAULT_FALLBACK_FILE = ".wa-webhook-dlq-fallback.jsonl";

export function waDlqFallbackFile(): string {
  return (process.env.WA_WEBHOOK_DLQ_FALLBACK_FILE ?? "").trim() || DEFAULT_FALLBACK_FILE;
}

/**
 * Persist a DLQ record that could not be inserted into Postgres.
 * Returns the backend used ("redis" | "file"). Throws only if BOTH durable
 * fallbacks fail (caller logs — the webhook has already been acked).
 */
export async function persistWaWebhookFallback(record: WaWebhookDlqRecord): Promise<"redis" | "file"> {
  const stamped = { ...record, fallbackAt: new Date().toISOString() };
  try {
    const { getRedis } = await import("../redis");
    const r = await getRedis();
    if (r) {
      await r.rpush(WA_DLQ_FALLBACK_REDIS_KEY, JSON.stringify(stamped));
      return "redis";
    }
  } catch (e: any) {
    console.warn("[wa-dlq-fallback] redis persist failed, trying file:", e?.message ?? e);
  }
  await appendFile(waDlqFallbackFile(), JSON.stringify(stamped) + "\n", "utf8");
  return "file";
}

/**
 * Ops alert for a DLQ-insert failure, via the existing admin-alerts path.
 * Tenant is resolved from the payload's phone_number_id; when no tenant
 * matches, the alert degrades to a loud console.error (never silent).
 * Never throws.
 */
export async function alertWaDlqInsertFailure(
  db: Db,
  record: WaWebhookDlqRecord,
  insertErr: unknown,
  fallbackBackend: "redis" | "file" | "none",
): Promise<void> {
  const errMsg = String((insertErr as any)?.message ?? insertErr).slice(0, 200);
  const body = `⚠️ WA webhook DLQ insert FAILED — event preserved via ${fallbackBackend} fallback. `
    + `phone_number_id=${record.phoneNumberId ?? "?"} message=${record.messageId ?? "?"} error=${errMsg}. `
    + `Replay with replayWaWebhookFallback() once the DB is healthy.`;
  try {
    let tenantId: string | null = null;
    if (record.phoneNumberId) {
      const [t] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.whatsappPhoneNumberId, record.phoneNumberId))
        .limit(1)
        .catch(() => [] as any[]);
      tenantId = t?.id ?? null;
    }
    if (!tenantId) {
      console.error(`[wa-dlq-fallback] ALERT (no tenant for phone_number_id=${record.phoneNumberId ?? "?"}): ${body}`);
      return;
    }
    const { notifyTenantAdminWhatsApp } = await import("./adminAlerts");
    const delivered = await notifyTenantAdminWhatsApp(db, tenantId, body);
    if (!delivered) {
      console.error(`[wa-dlq-fallback] ALERT not deliverable (tenant=${tenantId}): ${body}`);
    }
  } catch (e: any) {
    console.error("[wa-dlq-fallback] alert path failed:", e?.message ?? e, "—", body);
  }
}

/**
 * Dead-letter replay: re-insert fallback-persisted records into
 * wa_webhook_events. Redis entries are removed only after a successful
 * insert; the file is truncated by the number of successfully replayed lines.
 * Returns replay/remaining counts per backend. Never throws.
 */
export async function replayWaWebhookFallback(db: Db): Promise<{
  redis: { replayed: number; remaining: number };
  file: { replayed: number; remaining: number };
}> {
  const result = { redis: { replayed: 0, remaining: 0 }, file: { replayed: 0, remaining: 0 } };

  const insertOne = async (rec: WaWebhookDlqRecord): Promise<boolean> => {
    try {
      await db.insert(waWebhookEvents).values({
        id: rec.id,
        messageId: rec.messageId ?? null,
        phoneNumberId: rec.phoneNumberId ?? null,
        waPhoneNumber: rec.waPhoneNumber ?? null,
        messageType: rec.messageType ?? null,
        rawPayload: rec.rawPayload,
        status: "received",
        retryCount: 0,
        lastError: rec.fallbackReason ? `fallback-replay: ${rec.fallbackReason}`.slice(0, 500) : "fallback-replay",
      });
      return true;
    } catch (e: any) {
      console.warn("[wa-dlq-fallback] replay insert failed:", e?.message ?? e);
      return false;
    }
  };

  // ── Redis backend ──────────────────────────────────────────────────────
  try {
    const { getRedis } = await import("../redis");
    const r = await getRedis();
    if (r) {
      const items = await r.lrange(WA_DLQ_FALLBACK_REDIS_KEY, 0, -1);
      let replayed = 0;
      for (const raw of items) {
        let rec: WaWebhookDlqRecord | null = null;
        try { rec = JSON.parse(raw); } catch { /* skip corrupt line */ }
        if (rec && (await insertOne(rec))) replayed++;
        else break; // DB still unhealthy — stop, keep the rest queued
      }
      if (replayed > 0) await r.ltrim(WA_DLQ_FALLBACK_REDIS_KEY, replayed, -1);
      result.redis.replayed = replayed;
      result.redis.remaining = items.length - replayed;
    }
  } catch (e: any) {
    console.warn("[wa-dlq-fallback] redis replay failed:", e?.message ?? e);
  }

  // ── File backend ─────────────────────────────────────────────────────────
  try {
    const path = waDlqFallbackFile();
    const content = await readFile(path, "utf8").catch(() => "");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    let replayed = 0;
    for (const line of lines) {
      let rec: WaWebhookDlqRecord | null = null;
      try { rec = JSON.parse(line); } catch { /* skip corrupt line */ }
      if (rec && (await insertOne(rec))) replayed++;
      else break;
    }
    if (replayed === lines.length) {
      await writeFile(path, "", "utf8");
    } else if (replayed > 0) {
      await writeFile(path, lines.slice(replayed).join("\n") + "\n", "utf8");
    }
    result.file.replayed = replayed;
    result.file.remaining = lines.length - replayed;
  } catch (e: any) {
    console.warn("[wa-dlq-fallback] file replay failed:", e?.message ?? e);
  }

  return result;
}
