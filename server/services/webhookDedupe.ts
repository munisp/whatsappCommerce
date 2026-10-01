/**
 * Webhook idempotency ledger.
 *
 * Meta retries webhook deliveries until it gets a 200, so every inbound
 * message can arrive more than once. The dedupe guarantee is an INSERT-FIRST
 * claim against the `processed_webhook_events` ledger: the Meta wamid (event
 * id) is the primary key, so a retry/concurrent delivery collides on the PK
 * (ON CONFLICT DO NOTHING → zero rows returned) and is skipped. A message is
 * never reprocessed.
 *
 * Failure policy when the ledger table is unavailable (e.g. migration 0038
 * not yet applied):
 *   - production: FAIL CLOSED — the claim throws, the webhook returns 500 and
 *     Meta retries later (a blind dedupe ledger must not silently reprocess);
 *   - development/test: in-memory Set fallback with a loud warning so local
 *     dev without the migration keeps working.
 *
 * Retention: `sweepProcessedWebhookEvents` deletes rows older than 7 days
 * (invoked from the /api/cron/webhook-dedupe-sweep cron endpoint).
 */

import { and, eq, lt, or } from "drizzle-orm";
import type { getDb } from "../db";
import { processedWebhookEvents, waWebhookEvents, waMessageDeliveryReceipts } from "../../drizzle/schema";
import { isProd } from "../_core/env";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Retention window for the dedupe ledger. */
export const WEBHOOK_DEDUPE_RETENTION_DAYS = 7;

/** Dev/test-only fallback when the ledger table is missing. */
const memoryLedger = new Set<string>();
let memoryFallbackWarned = false;

/** Postgres "undefined_table" SQLSTATE. */
function isMissingTableError(err: any): boolean {
  return err?.code === "42P01" || /relation .* does not exist/i.test(err?.message ?? "");
}

export type ClaimResult = "claimed" | "duplicate";

/**
 * Claim a webhook event for processing. Returns "claimed" when this caller
 * won the insert-first race, "duplicate" when the event was already claimed.
 */
export async function claimWebhookEvent(
  db: Db,
  event: { id: string; tenantId: string; type: string },
): Promise<ClaimResult> {
  try {
    const inserted = await db
      .insert(processedWebhookEvents)
      .values({
        id: event.id,
        tenantId: event.tenantId,
        type: event.type,
        processedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: processedWebhookEvents.id });
    return inserted.length > 0 ? "claimed" : "duplicate";
  } catch (err: any) {
    if (isMissingTableError(err) && !isProd) {
      // Dev/test fallback: in-memory ledger. Loud, once per process.
      if (!memoryFallbackWarned) {
        memoryFallbackWarned = true;
        console.warn(
          "[webhook-dedupe] processed_webhook_events table missing — using " +
          "in-memory dedupe fallback (dev/test only; production fails closed)",
        );
      }
      if (memoryLedger.has(event.id)) return "duplicate";
      memoryLedger.add(event.id);
      return "claimed";
    }
    // Production (or a real DB error): fail closed — the webhook must 500 so
    // Meta retries instead of us silently reprocessing the message.
    throw err;
  }
}

/**
 * Delete ledger rows older than `retentionDays` (default 7). Returns the
 * number of rows deleted.
 */
export async function sweepProcessedWebhookEvents(
  db: Db,
  retentionDays: number = WEBHOOK_DEDUPE_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const deleted = await db
    .delete(processedWebhookEvents)
    .where(lt(processedWebhookEvents.processedAt, cutoff))
    .returning({ id: processedWebhookEvents.id });
  return deleted.length;
}

// === W48 integrations (PERF-INT-12) ===
/**
 * Retention sweep for the WA webhook artifact tables, whose rawPayload JSONB
 * (whole Meta batches on wa_webhook_events; per-status-event payloads on
 * wa_message_delivery_receipts) grew unboundedly — bloating table/index
 * storage and slowing inserts on the webhook ack path.
 *
 * Policy (env-tunable, defaults per audit):
 *   - wa_webhook_events: processed rows > WA_EVENTS_PROCESSED_RETENTION_DAYS
 *     (7d), failed rows > WA_EVENTS_FAILED_RETENTION_DAYS (30d — failed rows
 *     live longer so the retry heartbeat keeps its work);
 *   - wa_message_delivery_receipts: rows older than
 *     WA_RECEIPTS_RETENTION_HOURS (72h) — delivered/read receipts are
 *     high-volume and low-value after the delivery window.
 * Rows pending retry (status='received'/'failed' inside their window) are
 * NEVER touched. Runs from the recovery-sweeps plan (no new cron route).
 */
export const WA_EVENTS_PROCESSED_RETENTION_DAYS = Number(process.env.WA_EVENTS_PROCESSED_RETENTION_DAYS ?? 7);
export const WA_EVENTS_FAILED_RETENTION_DAYS = Number(process.env.WA_EVENTS_FAILED_RETENTION_DAYS ?? 30);
export const WA_RECEIPTS_RETENTION_HOURS = Number(process.env.WA_RECEIPTS_RETENTION_HOURS ?? 72);

export async function sweepWaWebhookArtifacts(
  db: Db,
  opts: { processedDays?: number; failedDays?: number; receiptsHours?: number } = {},
): Promise<{ eventsDeleted: number; receiptsDeleted: number }> {
  const processedDays = opts.processedDays ?? WA_EVENTS_PROCESSED_RETENTION_DAYS;
  const failedDays = opts.failedDays ?? WA_EVENTS_FAILED_RETENTION_DAYS;
  const receiptsHours = opts.receiptsHours ?? WA_RECEIPTS_RETENTION_HOURS;
  const processedCutoff = new Date(Date.now() - processedDays * 24 * 3600 * 1000);
  const failedCutoff = new Date(Date.now() - failedDays * 24 * 3600 * 1000);
  const receiptsCutoff = new Date(Date.now() - receiptsHours * 3600 * 1000);

  const eventsDeleted = await db
    .delete(waWebhookEvents)
    .where(or(
      and(eq(waWebhookEvents.status, "processed"), lt(waWebhookEvents.createdAt, processedCutoff)),
      and(eq(waWebhookEvents.status, "failed"), lt(waWebhookEvents.createdAt, failedCutoff)),
    ))
    .returning({ id: waWebhookEvents.id });

  const receiptsDeleted = await db
    .delete(waMessageDeliveryReceipts)
    .where(lt(waMessageDeliveryReceipts.createdAt, receiptsCutoff))
    .returning({ id: waMessageDeliveryReceipts.id });

  return { eventsDeleted: eventsDeleted.length, receiptsDeleted: receiptsDeleted.length };
}

/** Test helper: reset the in-memory fallback ledger. */
export function __resetMemoryLedgerForTests(): void {
  memoryLedger.clear();
  memoryFallbackWarned = false;
}
