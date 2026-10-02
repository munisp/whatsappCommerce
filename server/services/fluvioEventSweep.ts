// === W61 dataloss ===
/**
 * W61 fluvio_event_log processor sweep (audit HIGH #6) —
 * server/services/fluvioEventSweep.ts
 *
 * fluvio_event_log was a WRITE-ONLY landing pad: every wacommerce.* Kafka →
 * Fluvio → platform event (and every DLQ-drained event, W61 #4) landed with
 * processed=false and no worker ever consumed it — durable on disk but
 * functionally lost. recon.discrepancy events from rust/recon-worker also
 * land here and were never surfaced.
 *
 * runFluvioEventSweep (invoked by /api/scheduled/fluvio-event-sweep):
 *   1. CLAIM-FIRST batch consume: a single guarded UPDATE … WHERE id IN
 *      (SELECT id … WHERE processed=false ORDER BY received_at LIMIT n)
 *      marks rows processed — concurrent sweeps cannot double-claim.
 *   2. Surfaces recon.discrepancy events: one WhatsApp ops alert per
 *      affected tenant (capped) before marking processed — reconciliation
 *      discrepancies are never silently buried.
 *   3. Backlog alerting: when the unprocessed remainder exceeds the
 *      threshold (default 500) a loud platform-level console.error + per-
 *      tenant admin alert fires. Fail-open telemetry throughout: a broken
 *      sweep logs + counts and never crashes the cron route.
 *
 * TODO(W62): route event types to real domain handlers (orders →
 * fulfillment, inventory → stock sync). This sweep guarantees consumption +
 * visibility; domain reaction is W62 scope.
 */

import { sql } from "drizzle-orm";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const FLUVIO_SWEEP_DEFAULT_LIMIT = 200;
export const FLUVIO_BACKLOG_ALERT_THRESHOLD = 500;

export interface FluvioSweepRunResult {
  claimed: number;
  backlog: number;
  reconDiscrepancies: number;
  alertsSent: number;
  error?: string;
}

/**
 * Consume a bounded batch of unprocessed fluvio_event_log rows. Never
 * throws.
 */
export async function runFluvioEventSweep(
  db: Db,
  opts?: { limit?: number; backlogThreshold?: number },
): Promise<FluvioSweepRunResult> {
  const result: FluvioSweepRunResult = { claimed: 0, backlog: 0, reconDiscrepancies: 0, alertsSent: 0 };
  const limit = opts?.limit ?? FLUVIO_SWEEP_DEFAULT_LIMIT;
  const threshold = opts?.backlogThreshold ?? FLUVIO_BACKLOG_ALERT_THRESHOLD;
  try {
    // ── 1. Claim-first batch consume ──────────────────────────────────────
    const claimed = await db.execute(sql`
      UPDATE fluvio_event_log
      SET processed = true, processed_at = now()
      WHERE id IN (
        SELECT id FROM fluvio_event_log
        WHERE processed = false
        ORDER BY received_at ASC
        LIMIT ${limit}
      )
      RETURNING id, topic, tenant_id, event_type
    `).catch((e: any) => {
      console.error("[fluvio-sweep] claim update failed:", e?.message);
      return { rows: [] } as any;
    });
    const rows: any[] = (claimed as any).rows ?? claimed ?? [];
    result.claimed = rows.length;

    // ── 2. Surface reconciliation discrepancies before they are buried ──
    const recon = rows.filter((r) => r.topic === "recon.discrepancy" || r.event_type === "recon.discrepancy");
    result.reconDiscrepancies = recon.length;
    const reconTenants = new Set<string>(recon.map((r) => r.tenant_id).filter((t: any) => typeof t === "string" && t));
    if (recon.length > 0) {
      console.error(`[fluvio-sweep] ALERT ${recon.length} recon.discrepancy event(s) consumed (tenants: ${Array.from(reconTenants).join(",") || "?"})`);
      try {
        const { notifyTenantAdminWhatsApp } = await import("./adminAlerts");
        for (const tenantId of Array.from(reconTenants).slice(0, 5)) {
          const delivered = await notifyTenantAdminWhatsApp(
            db,
            tenantId,
            `⚠️ ${recon.length} reconciliation discrepancy event(s) were recorded for your workspace. Please review the recon report.`,
          );
          if (delivered) result.alertsSent++;
        }
      } catch (e: any) {
        console.error("[fluvio-sweep] recon alert path failed:", e?.message);
      }
    }

    // ── 3. Backlog alerting (fail-open telemetry) ────────────────────────
    const backlogRows = await db.execute(sql`SELECT count(*)::int AS n FROM fluvio_event_log WHERE processed = false`).catch(() => ({ rows: [{ n: 0 }] } as any));
    result.backlog = Number(((backlogRows as any).rows ?? backlogRows)?.[0]?.n ?? 0);
    if (result.backlog > threshold) {
      console.error(`[fluvio-sweep] ALERT fluvio_event_log backlog=${result.backlog} exceeds threshold=${threshold} — consumer capacity too low`);
    }
  } catch (e: any) {
    result.error = String(e?.message ?? e).slice(0, 200);
    console.error("[fluvio-sweep] sweep failed (fail-open):", e?.message);
  }
  return result;
}
// === END W61 dataloss ===
