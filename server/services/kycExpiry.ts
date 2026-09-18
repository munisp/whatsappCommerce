/**
 * === W46 kyc === TEN-6 — KYC/KYB application expiry lifecycle.
 *
 * Previously `kyc_applications.expiresAt` was dead schema (only liveness
 * sessions got expiresAt). Now:
 *   - Review APPROVAL stamps expiresAt = approvedAt + validity(riskTier).
 *     Risk tier is derived from fields already on the application:
 *       high     — PEP declared or numeric riskScore >= 70
 *       standard — numeric riskScore >= 40 (or unknown)
 *       low      — everything else
 *     high: 180d · standard: 365d · low: 730d (re-verification cadence).
 *   - The scheduled /api/scheduled/kyc-expiry-sweep (runKycExpirySweep)
 *     flips approved applications past expiresAt to 'expired' (guarded
 *     UPDATE — an application already re-reviewed between read and write
 *     is not clobbered), writes an audit row, and notifies the tenant admin
 *     over WhatsApp (adminAlerts) that re-verification is required.
 *   - Re-verification flow: kyc.getOrCreateApplication already treats
 *     'expired' as re-openable — the merchant simply starts a fresh
 *     application; the kycGate hard precondition (status='approved') fails
 *     closed the moment the sweep flips the row.
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { kycApplications, type KycApplication } from "../../drizzle/schema";
import { writeAuditLog } from "../routers/audit";
import { notifyTenantAdminWhatsApp } from "./adminAlerts";

type DbLike = any;

export type KycRiskTier = "high" | "standard" | "low";

/** Validity period per risk tier, in days. */
export const KYC_VALIDITY_DAYS: Record<KycRiskTier, number> = {
  high: 180,
  standard: 365,
  low: 730,
};

/** Derive the risk tier from the application's own screening fields. */
export function computeRiskTier(app: {
  pepDeclared?: boolean | null;
  riskScore?: string | null;
}): KycRiskTier {
  if (app.pepDeclared) return "high";
  const score = app.riskScore != null ? Number(app.riskScore) : NaN;
  if (Number.isFinite(score)) {
    if (score >= 70) return "high";
    if (score >= 40) return "standard";
    return "low";
  }
  return "standard"; // unknown score → honest middle tier
}

/** expiresAt for an approval granted at `approvedAt`. */
export function kycExpiresAt(app: Parameters<typeof computeRiskTier>[0], approvedAt: Date): Date {
  const tier = computeRiskTier(app);
  return new Date(approvedAt.getTime() + KYC_VALIDITY_DAYS[tier] * 86_400_000);
}

export interface KycExpirySweepResult {
  expired: number;
  notified: number;
  errors: number;
}

/**
 * Flip approved applications whose expiresAt has passed to 'expired'.
 * Claim-first: the UPDATE is guarded on status='approved' so a concurrent
 * admin review (re-approval moving the row out of 'approved') wins and the
 * sweep row-affected count tells us whether we actually expired it.
 * Never throws per-application; one bad tenant does not stop the sweep.
 */
export async function runKycExpirySweep(
  db: DbLike,
  now: Date = new Date(),
  limit = 500,
): Promise<KycExpirySweepResult> {
  const result: KycExpirySweepResult = { expired: 0, notified: 0, errors: 0 };
  const due = (await db.select().from(kycApplications)
    .where(and(
      eq(kycApplications.status, "approved"),
      isNotNull(kycApplications.expiresAt),
      lt(kycApplications.expiresAt, now),
    ))
    .limit(limit)) as KycApplication[];

  for (const app of due) {
    try {
      const tier = computeRiskTier(app);
      const updated = await db.update(kycApplications)
        .set({
          status: "expired",
          reviewNotes: [
            app.reviewNotes,
            `[kyc-expiry] expired at ${now.toISOString()} (tier=${tier}, validity ${KYC_VALIDITY_DAYS[tier]}d) — re-verification required`,
          ].filter(Boolean).join("\n"),
          updatedAt: now,
        })
        .where(and(
          eq(kycApplications.id, app.id),
          // Guarded flip: only expire if STILL approved (a concurrent
          // re-approval between our SELECT and UPDATE must win).
          eq(kycApplications.status, "approved"),
        ))
        .returning({ id: kycApplications.id });
      if (!updated.length) continue; // lost the race — skip notify/audit

      result.expired++;
      await writeAuditLog({
        actorId: "system:kyc-expiry-sweep",
        actorRole: "admin",
        action: "kyc.expired",
        entityType: "kyc_application",
        entityId: app.id,
        tenantId: app.tenantId,
        summary: `KYC application ${app.id} (tenant ${app.tenantId}) expired at ${now.toISOString()} (tier=${tier}); re-verification required`,
        before: { status: "approved", expiresAt: app.expiresAt },
        after: { status: "expired" },
      });
      const sent = await notifyTenantAdminWhatsApp(
        db,
        app.tenantId,
        `Your ${app.type.toUpperCase()} verification has expired (risk tier: ${tier}). ` +
        `Please complete re-verification to keep selling — open the KYC section to start a new application.`,
      );
      if (sent) result.notified++;
    } catch (err) {
      result.errors++;
      console.error(`[kyc-expiry-sweep] failed for application ${app.id}:`, (err as Error)?.message);
    }
  }
  return result;
}
// === END W46 kyc ===
