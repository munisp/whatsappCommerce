/**
 * === W40 TEN-5 (Coder B) ===
 * J277 — KYC artifacts are inside the GDPR/NDPR erasure + export perimeter.
 *
 *   1. exportMyData now includes the tenant's KYC applications, document
 *      metadata + OCR text, and liveness checks (previously: user/orders/
 *      escrows/wallet only).
 *   2. requestErasure scrubs DB-resident KYC PII immediately (ocrRawText,
 *      extractedData, fileUrl/fileName, applicant + UBO PII, liveness
 *      analysis) AND attempts the S3 scan delete. In the sim there is no
 *      object store, so the delete honestly TOMBSTONES the row
 *      (erasureScheduledAt) instead of pretending success — the scheduled
 *      kyc-erasure-sweep retries it (verified: the sweep scans the
 *      tombstoned row and reports the still-failing delete).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J277",
  name: "KYC artifacts in GDPR export + erasure (TEN-5)",
  feature: "exportMyData includes KYC docs/OCR/liveness; requestErasure scrubs KYC PII + tombstones S3 scans for the erasure sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    process.env.TEMPORAL_ADDRESS = "127.0.0.1:1";

    // ── Fresh tenant + a user operating it ───────────────────────────────
    const started = await admin.onboarding.start({ name: "GDPR KYC Store", plan: "starter" });
    const tenantId = started.tenantId;
    assert(tenantId, "tenant provisioned");
    const [u] = await world.db.insert(schema.users).values({
      openId: `w40-j277-${randomUUID().slice(0, 8)}`,
      email: "j277@sim.local", name: "J277 User",
      loginMethod: "keycloak", role: "user", tenantId, lastSignedIn: new Date(),
    }).returning();
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: {
        id: u.id, openId: u.openId, email: u.email, name: u.name,
        loginMethod: "keycloak", role: "user", tenantId,
        createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
      },
      req: { protocol: "http", headers: {} },
      res: { clearCookie: () => {} },
    } as any);

    // ── KYC application + a document row with OCR PII (S3 scan reference) ─
    const app = await caller.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
    await caller.kyc.updateApplication({
      applicationId: app.id,
      applicantName: "Ada Lovelace",
      businessName: "GDPR KYC Store Ltd",
      businessRegistrationNumber: "RC-J277",
      businessCountry: "NG",
      uboName: "Ada Lovelace",
    });
    const docId = randomUUID();
    await world.db.insert(schema.kycDocuments).values({
      id: docId,
      applicationId: app.id,
      tenantId,
      documentType: "national_id",
      fileKey: `kyc/${app.id}/national_id-j277`,
      fileUrl: `/api/storage/kyc/${app.id}/national_id-j277`,
      fileName: "ada-national-id.jpg",
      mimeType: "image/jpeg",
      ocrRawText: "NATIONAL ID — Ada Lovelace — NIN 12345678901",
      ocrConfidence: "0.98",
      extractedData: { nin: "12345678901", name: "Ada Lovelace" },
      createdAt: new Date(),
    });
    await world.db.insert(schema.livenessChecks).values({
      id: randomUUID(),
      applicationId: app.id,
      tenantId,
      status: "passed",
      analysisResult: { faceMatch: 0.99, spoof: false },
      createdAt: new Date(),
    });

    // ── 1. Export includes KYC artifacts ─────────────────────────────────
    const exported = await caller.privacy.exportMyData();
    const kyc = (exported as any).kyc;
    assert(kyc, "export includes a kyc section");
    assert(kyc.applications.length === 1, "export includes the KYC application");
    assert(kyc.applications[0].uboName === "Ada Lovelace", "export includes UBO field");
    assert(kyc.documents.length === 1, "export includes the KYC document");
    assert(kyc.documents[0].ocrRawText.includes("12345678901"), "export includes OCR text");
    assert(kyc.livenessChecks.length === 1, "export includes liveness checks");

    // ── 2. Erasure scrubs KYC PII + tombstones the S3 scan ───────────────
    const erased = await caller.privacy.requestErasure({ reason: "J277 DSAR" });
    assert(erased.status === "completed", "erasure completed (no open escrows/withdrawals)");
    const k = (erased as any).kycErasure;
    assert(k && k.documentsScrubbed === 1, `KYC document scrubbed (got ${JSON.stringify(k)})`);
    assert(k.s3Scheduled === 1 && k.s3Deleted === 0,
      "S3 unreachable in sim → scan honestly tombstoned for the sweep (not faked as deleted)");

    const [doc] = await world.db.select().from(schema.kycDocuments).where(eq(schema.kycDocuments.id, docId));
    assert(doc.ocrRawText === null && doc.extractedData === null, "OCR text + extracted data scrubbed immediately");
    assert(doc.fileUrl === null && doc.fileName === null, "file references scrubbed immediately");
    assert(doc.erasureScheduledAt && !doc.erasedAt, "tombstone set, erasure not falsely marked complete");

    const [appRow] = await world.db.select().from(schema.kycApplications).where(eq(schema.kycApplications.id, app.id));
    assert(appRow.applicantName === null && appRow.uboName === null, "applicant + UBO PII scrubbed");

    const [liv] = await world.db.select().from(schema.livenessChecks)
      .where(eq(schema.livenessChecks.applicationId, app.id));
    assert(liv.analysisResult === null, "liveness analysis (biometrics-adjacent) scrubbed");

    // ── 3. The erasure sweep picks up the tombstone (retry still fails in sim) ──
    const { runKycErasureSweep } = await import("../../server/services/kycPrivacy");
    const sweep = await runKycErasureSweep(world.db);
    assert(sweep.scanned >= 1, "sweep found the tombstoned document");
    assert(sweep.deleted === 0 && sweep.failed >= 1, "sweep honestly reports the still-failing S3 delete");

    // Erasure request is journaled for DPO oversight.
    const reqs = await world.db.select().from(schema.erasureRequests)
      .where(eq(schema.erasureRequests.userId, u.id));
    assert(reqs.length === 1 && reqs[0].status === "completed", "erasure request journaled");
  },
};
