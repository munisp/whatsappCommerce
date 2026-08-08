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

import { lt } from "drizzle-orm";
import type { getDb } from "../db";
import { processedWebhookEvents } from "../../drizzle/schema";
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

/** Test helper: reset the in-memory fallback ledger. */
export function __resetMemoryLedgerForTests(): void {
  memoryLedger.clear();
  memoryFallbackWarned = false;
}
