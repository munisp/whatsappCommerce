/**
 * W40 TEN-5 + TEN-8 — KYC privacy & re-screening depth.
 *
 * TEN-5 (GDPR/NDPR scope): KYC document scans (S3 objects) and their OCR
 * text are now inside the erasure/export perimeter.
 *   - Export: document metadata + OCR text + extracted data + liveness
 *     results are included in privacy.exportMyData (collectKycExport).
 *   - Erasure (eraseKycArtifactsForTenant): DB-resident PII (ocrRawText,
 *     extractedData, vlmAnalysis, doclingStructure, fileName, fileUrl) is
 *     nulled IMMEDIATELY. The S3 object delete is attempted immediately;
 *     on success erasedAt is set. If the object store is unreachable the
 *     row is tombstoned (erasureScheduledAt) and the scheduled
 *     /api/scheduled/kyc-erasure-sweep retries the delete until erasedAt is
 *     set (runKycErasureSweep). HONEST LIMITATION: until erasedAt is set
 *     the S3 object may still exist; it is unreachable from the app because
 *     fileUrl is already nulled.
 *
 * TEN-8 (sanctions depth): periodic re-screening (runKybRescreenSweep)
 * re-screens every KYB application that has business identity fields
 * through the SAME fail-closed path used at review time (runKybChecks —
 * business name + UBO), journals lastScreenedAt, and on a NEW reject
 * recommendation moves the application back to under_review (fail-closed:
 * a newly-sanctioned merchant is never left approved) plus an audit row.
 * Screening provider capability is unchanged — W40 adds fields + cadence,
 * not a new data vendor.
 */
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { kycApplications, kycDocuments, livenessChecks } from "../../drizzle/schema";
import { storageDelete } from "../storage";
import { writeAuditLog } from "../routers/audit";
import { runKybScreenFor, kybScreeningEnabled, KYB_NOTE_RE } from "../routers/kyc";

type DbLike = any;

// ---------------------------------------------------------------------------
// TEN-5: export
// ---------------------------------------------------------------------------

/** Everything KYC-related we hold for a tenant, for DSAR portability export. */
export async function collectKycExport(db: DbLike, tenantId: string) {
  const applications = await db.select().from(kycApplications)
    .where(eq(kycApplications.tenantId, tenantId))
    .orderBy(desc(kycApplications.createdAt));
  const appIds = applications.map((a: any) => a.id as string);
  const documents = appIds.length
    ? await db.select().from(kycDocuments)
        .where(eq(kycDocuments.tenantId, tenantId))
        .orderBy(desc(kycDocuments.createdAt))
    : [];
  const liveness = appIds.length
    ? await db.select().from(livenessChecks)
        .where(eq(livenessChecks.tenantId, tenantId))
        .orderBy(desc(livenessChecks.createdAt))
    : [];
  return {
    applications,
    // Document metadata + OCR text + extracted data. The scan binary itself
    // is exported as its storage key/url reference (or null after erasure).
    documents: documents.map((d: any) => ({
      id: d.id,
      applicationId: d.applicationId,
      documentType: d.documentType,
      fileName: d.fileName,
      fileKey: d.fileKey,
      fileUrl: d.fileUrl,
      mimeType: d.mimeType,
      ocrRawText: d.ocrRawText,
      ocrConfidence: d.ocrConfidence,
      extractedData: d.extractedData,
      isAuthentic: d.isAuthentic,
      isTampered: d.isTampered,
      verificationNotes: d.verificationNotes,
      erasedAt: d.erasedAt ?? null,
      erasureScheduledAt: d.erasureScheduledAt ?? null,
      createdAt: d.createdAt,
    })),
    livenessChecks: liveness,
  };
}

// ---------------------------------------------------------------------------
// TEN-5: erasure
// ---------------------------------------------------------------------------

export interface KycErasureResult {
  applications: number;
  documentsScrubbed: number;
  s3Deleted: number;
  /** S3 deletes that failed — tombstoned for the erasure sweep to retry. */
  s3Scheduled: number;
}

/**
 * Scrub KYC PII for a tenant: null DB-resident document PII immediately and
 * delete the S3 scans (tombstone + scheduled retry when the delete fails).
 * Liveness analysis JSON (biometrics-adjacent) is scrubbed too.
 */
export async function eraseKycArtifactsForTenant(db: DbLike, tenantId: string): Promise<KycErasureResult> {
  const docs = await db.select().from(kycDocuments).where(eq(kycDocuments.tenantId, tenantId));
  let s3Deleted = 0;
  let s3Scheduled = 0;
  const now = new Date();

  for (const d of docs as any[]) {
    if (d.erasedAt) continue; // already fully erased — idempotent
    let erased = false;
    if (d.fileKey) {
      try {
        await storageDelete(d.fileKey);
        erased = true;
        s3Deleted++;
      } catch (err) {
        // Object store unreachable — tombstone for the erasure sweep. The DB
        // PII below is STILL scrubbed now; only the binary awaits deletion.
        s3Scheduled++;
        console.warn(`[kyc-privacy] S3 delete failed for ${d.fileKey} — tombstoned for retry:`, (err as Error)?.message);
      }
    } else {
      erased = true; // no binary stored
    }
    await db.update(kycDocuments).set({
      ocrRawText: null,
      ocrConfidence: null,
      extractedData: null,
      vlmAnalysis: null,
      doclingStructure: null,
      fileName: null,
      fileUrl: null,
      ...(erased ? { erasedAt: now } : { erasureScheduledAt: d.erasureScheduledAt ?? now }),
    }).where(eq(kycDocuments.id, d.id));
  }

  // Liveness analysis (face-match / spoof analysis) is biometrics-adjacent.
  await db.update(livenessChecks).set({ analysisResult: null })
    .where(eq(livenessChecks.tenantId, tenantId));

  // Applicant PII on the application itself.
  const apps = await db.update(kycApplications).set({
    applicantName: null,
    applicantEmail: null,
    applicantPhone: null,
    uboName: null,
    uboDob: null,
    updatedAt: now,
  }).where(eq(kycApplications.tenantId, tenantId));

  return {
    applications: Array.isArray(apps) ? apps.length : (apps?.rowCount ?? 0),
    documentsScrubbed: docs.filter((d: any) => !d.erasedAt).length,
    s3Deleted,
    s3Scheduled,
  };
}

/**
 * Scheduled sweep: retry S3 deletion for tombstoned documents
 * (erasureScheduledAt set, erasedAt null). Idempotent.
 */
export async function runKycErasureSweep(db: DbLike, limit = 200) {
  const pending = await db.select().from(kycDocuments)
    .where(and(isNotNull(kycDocuments.erasureScheduledAt), isNull(kycDocuments.erasedAt)))
    .limit(limit);
  let deleted = 0;
  let failed = 0;
  for (const d of pending as any[]) {
    try {
      if (d.fileKey) await storageDelete(d.fileKey);
      await db.update(kycDocuments).set({ erasedAt: new Date() }).where(eq(kycDocuments.id, d.id));
      deleted++;
    } catch (err) {
      failed++;
      console.warn(`[kyc-erasure-sweep] retry failed for doc ${d.id}:`, (err as Error)?.message);
    }
  }
  return { scanned: pending.length, deleted, failed };
}

// ---------------------------------------------------------------------------
// TEN-8: periodic re-screening
// ---------------------------------------------------------------------------

export interface KybRescreenResult {
  screened: number;
  clean: number;
  manualReview: number;
  /** New reject recommendations — applications moved back to under_review. */
  rejected: number;
  skipped: number;
}

/**
 * Re-screen every KYB application with business identity fields (any status
 * except rejected/expired — those are terminal) through the SAME fail-closed
 * screening path used at review time, journal lastScreenedAt, and fail
 * closed on a new reject: the application is moved to under_review and an
 * audit row is written. Never throws per-application; a screening error on
 * one merchant does not stop the sweep.
 */
export async function runKybRescreenSweep(db: DbLike, limit = 500): Promise<KybRescreenResult> {
  const result: KybRescreenResult = { screened: 0, clean: 0, manualReview: 0, rejected: 0, skipped: 0 };
  if (!kybScreeningEnabled()) return result;

  const apps = await db.select().from(kycApplications)
    .where(and(
      eq(kycApplications.type, "kyb"),
      ne(kycApplications.status, "rejected"),
      ne(kycApplications.status, "expired"),
    ))
    .limit(limit);

  for (const app of apps as any[]) {
    if (!app.businessName || !app.businessRegistrationNumber || !app.businessCountry) {
      result.skipped++;
      continue;
    }
    let kyb;
    try {
      kyb = await runKybScreenFor(app);
    } catch (err) {
      result.skipped++;
      console.error(`[kyb-rescreen] screening error for application ${app.id}:`, (err as Error)?.message);
      continue;
    }
    if (!kyb) { result.skipped++; continue; }
    result.screened++;
    const now = new Date();
    const note = `[kyb-rescreen] recommendation=${kyb.recommendation} at ${now.toISOString()} — ${kyb.reasons.join("; ")}`;
    const prior = (app.reviewNotes ?? "").split("\n").filter((l: string) => !KYB_NOTE_RE.test(l) && !l.startsWith("[kyb-rescreen]"));

    if (kyb.recommendation === "reject") {
      // Fail closed: a merchant newly matching a sanctions list must NOT
      // remain approved. Move to under_review + audit; admin re-adjudicates.
      await db.update(kycApplications).set({
        status: "under_review",
        reviewNotes: [...prior, note].filter(Boolean).join("\n"),
        lastScreenedAt: now,
        updatedAt: now,
      }).where(eq(kycApplications.id, app.id));
      await writeAuditLog({
        actorId: "system:kyb-rescreen",
        actorRole: "admin",
        action: "kyb.rescreen.reject",
        entityType: "kyc_application",
        entityId: app.id,
        tenantId: app.tenantId,
        summary: `Periodic re-screen returned reject for tenant ${app.tenantId}; application moved to under_review`,
        after: { recommendation: kyb.recommendation, reasons: kyb.reasons.slice(0, 5) },
      });
      result.rejected++;
    } else {
      await db.update(kycApplications).set({
        reviewNotes: [...prior, note].filter(Boolean).join("\n"),
        lastScreenedAt: now,
        updatedAt: now,
      }).where(eq(kycApplications.id, app.id));
      if (kyb.recommendation === "manual_review") result.manualReview++;
      else result.clean++;
    }
  }
  return result;
}
