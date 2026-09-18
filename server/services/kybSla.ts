// === W46 privacy-consent (TEN-22) ===
/**
 * kybSla.ts — KYB manual-review queue SLA + escalation sweep.
 *
 * Every KYB submission is stamped with slaDueAt (submittedAt +
 * KYB_REVIEW_SLA_HOURS). The kyb-sla-sweep cron (W42 cronAuth scope+jti,
 * scheduler.mjs allowlist) finds pending/under_review applications past
 * their SLA and:
 *   1. ESCALATES — sets escalatedAt and alerts the platform KYB review
 *      channel (ops log + tenant admin alert) exactly once;
 *   2. RECORDS the breach — sets slaBreachedAt; breaching applications are
 *      surfaced by reviewQueueStats for the ops dashboard.
 * Claim-first: the escalation flip is a guarded UPDATE on escalatedAt IS
 * NULL so two overlapping sweeps never double-alert.
 */
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { kycApplications } from "../../drizzle/schema";

/** Hours a KYB submission may wait for review before it breaches SLA. */
export const KYB_REVIEW_SLA_HOURS = 48;

/** Statuses that are in the human review queue (kyc_status enum members
 * only — resubmit_required waits on the APPLICANT, not the reviewer). */
export const KYB_QUEUE_STATUSES = ["pending", "under_review"] as const;

/** Stamp the SLA deadline at submit time. */
export function kybSlaDueAt(submittedAt: Date, slaHours: number = KYB_REVIEW_SLA_HOURS): Date {
  return new Date(submittedAt.getTime() + slaHours * 3600_000);
}

export interface KybSlaSweepResult {
  scanned: number;
  escalated: number;
  breached: number;
  escalatedIds: string[];
}

/**
 * Escalate overdue KYB reviews + record SLA breaches. Idempotent (the
 * guarded escalatedAt flip claims each row once). `now` is injectable for
 * tests/journeys.
 */
export async function runKybSlaSweep(
  db: any,
  now: Date = new Date(),
): Promise<KybSlaSweepResult> {
  const overdue = await db
    .select({
      id: kycApplications.id,
      tenantId: kycApplications.tenantId,
      status: kycApplications.status,
      slaDueAt: kycApplications.slaDueAt,
      escalatedAt: kycApplications.escalatedAt,
      slaBreachedAt: kycApplications.slaBreachedAt,
    })
    .from(kycApplications)
    .where(and(
      inArray(kycApplications.status, [...KYB_QUEUE_STATUSES]),
      isNotNull(kycApplications.slaDueAt),
      lt(kycApplications.slaDueAt, now),
    ));

  const result: KybSlaSweepResult = { scanned: overdue.length, escalated: 0, breached: 0, escalatedIds: [] };
  for (const app of overdue) {
    if (!app.slaBreachedAt) {
      // Breach recording is idempotent too (guarded on slaBreachedAt IS NULL).
      const flipped = await db
        .update(kycApplications)
        .set({ slaBreachedAt: now, updatedAt: now })
        .where(and(eq(kycApplications.id, app.id), isNull(kycApplications.slaBreachedAt)))
        .returning({ id: kycApplications.id });
      if (flipped.length > 0) {
        result.breached++;
        console.warn(
          `[kyb-sla] BREACH: KYB application ${app.id} (tenant ${app.tenantId}) exceeded ` +
          `${KYB_REVIEW_SLA_HOURS}h review SLA (due ${app.slaDueAt?.toISOString?.() ?? app.slaDueAt})`,
        );
      }
    }
    if (!app.escalatedAt) {
      // Claim-first escalation: only ONE sweep flips escalatedAt and alerts.
      const claimed = await db
        .update(kycApplications)
        .set({ escalatedAt: now, updatedAt: now })
        .where(and(eq(kycApplications.id, app.id), isNull(kycApplications.escalatedAt)))
        .returning({ id: kycApplications.id });
      if (claimed.length > 0) {
        result.escalated++;
        result.escalatedIds.push(app.id);
        // Alert the tenant (their review is overdue) + ops log for the
        // platform review queue. Alerting never blocks the sweep.
        try {
          const { sendAdminOpsAlert } = await import("./payments/disputes");
          await sendAdminOpsAlert(
            db,
            app.tenantId,
            `⏰ Your business verification (KYB) review has exceeded our ${KYB_REVIEW_SLA_HOURS}h SLA and has been escalated to a senior reviewer. Application ${app.id}.`,
            "kyb_sla_breach",
          );
        } catch (e: any) {
          console.warn(`[kyb-sla] escalation alert failed for ${app.id}:`, e?.message);
        }
      }
    }
  }
  return result;
}

/** Review-queue snapshot for ops dashboards: queue size, overdue, breached. */
export async function reviewQueueStats(db: any, now: Date = new Date()) {
  // Plain drizzle select + in-memory counting (queue volume is small; this
  // avoids driver-specific raw-SQL parameter edge cases in the sim stack).
  const rows = await db
    .select({
      status: kycApplications.status,
      slaDueAt: kycApplications.slaDueAt,
      escalatedAt: kycApplications.escalatedAt,
      slaBreachedAt: kycApplications.slaBreachedAt,
    })
    .from(kycApplications);
  const queuedRows = rows.filter((r: any) => (KYB_QUEUE_STATUSES as readonly string[]).includes(r.status));
  return {
    queued: queuedRows.length,
    overdue: queuedRows.filter((r: any) => r.slaDueAt && new Date(r.slaDueAt) < now).length,
    breachedTotal: rows.filter((r: any) => !!r.slaBreachedAt).length,
    escalatedOpen: queuedRows.filter((r: any) => !!r.escalatedAt).length,
    slaHours: KYB_REVIEW_SLA_HOURS,
  };
}
