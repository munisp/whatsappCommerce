import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertTenantAccess } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { kycApplications, kycDocuments, livenessChecks } from "../../drizzle/schema";
import type { KycApplication } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { storagePut } from "../storage";
import { runKybChecks, type KybCheckResult } from "../services/compliance";

// ── A3-F01: KYB screening wiring ─────────────────────────────────────────────
// runKybChecks (registry verification + sanctions) was dead code; it is now
// wired into the KYB lifecycle below. Screening is SKIPPED (legacy behavior)
// only when the registry provider is disabled AND no SANCTIONS_LIST_URL is
// configured. When screening runs, review approval fails closed on `reject`
// or on a degraded sanctions result.
const KYB_NOTE_RE = /\[kyb-screen\] recommendation=(auto_approve|manual_review|reject)/;

function kybScreeningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = (env.COMPLIANCE_REGISTRY_PROVIDER ?? "disabled").trim();
  return provider !== "disabled" || Boolean(env.SANCTIONS_LIST_URL);
}

async function runKybScreenFor(app: {
  businessName?: string | null;
  businessRegistrationNumber?: string | null;
  businessCountry?: string | null;
}): Promise<KybCheckResult | null> {
  if (!kybScreeningEnabled()) return null;
  if (!app.businessName || !app.businessRegistrationNumber || !app.businessCountry) return null;
  return runKybChecks({
    businessName: app.businessName,
    registrationNumber: app.businessRegistrationNumber,
    country: app.businessCountry,
  });
}

function kybNote(result: KybCheckResult): string {
  return `[kyb-screen] recommendation=${result.recommendation} at ${new Date().toISOString()} — ${result.reasons.join("; ")}`;
}

const KYC_SERVICE_URL = process.env.KYC_SERVICE_URL ?? "http://localhost:8001";
const KYC_API_KEY = process.env.KYC_INTERNAL_API_KEY ?? "dev-kyc-key";

async function callKycService(path: string, options: RequestInit = {}) {
  const res = await fetch(`${KYC_SERVICE_URL}${path}`, {
    ...options,
    headers: {
      "x-api-key": KYC_API_KEY,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`KYC service error: ${res.status}`);
  return res.json();
}

export const kycRouter = router({
  // Get or create a KYC/KYB application for a tenant
  getOrCreateApplication: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      type: z.enum(["kyc", "kyb"]).default("kyb"),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      const [existing] = await db.select().from(kycApplications)
        .where(and(
          eq(kycApplications.tenantId, input.tenantId),
          eq(kycApplications.type, input.type),
        ))
        .orderBy(desc(kycApplications.createdAt))
        .limit(1);

      if (existing && !["rejected", "expired"].includes(existing.status)) {
        return existing;
      }

      const id = randomUUID();
      await db.insert(kycApplications).values({
        id,
        tenantId: input.tenantId,
        type: input.type,
        status: "not_started",
      });
      const [created] = await db.select().from(kycApplications).where(eq(kycApplications.id, id));
      return created;
    }),

  // Get application with documents and liveness
  getApplication: protectedProcedure
    .input(z.object({ applicationId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const [app] = await db.select().from(kycApplications)
        .where(eq(kycApplications.id, input.applicationId)).limit(1);
      if (!app) return null;
      // Ownership: the application belongs to a tenant the caller may access.
      assertTenantAccess(ctx.user, app.tenantId);
      const docs = await db.select().from(kycDocuments)
        .where(eq(kycDocuments.applicationId, input.applicationId))
        .orderBy(desc(kycDocuments.createdAt));
      const [liveness] = await db.select().from(livenessChecks)
        .where(eq(livenessChecks.applicationId, input.applicationId))
        .orderBy(desc(livenessChecks.createdAt)).limit(1);
      return { ...app, documents: docs, liveness: liveness ?? null };
    }),

  // Update application business info
  updateApplication: protectedProcedure
    .input(z.object({
      applicationId: z.string(),
      applicantName: z.string().optional(),
      applicantEmail: z.string().email().optional(),
      applicantPhone: z.string().optional(),
      businessName: z.string().optional(),
      businessRegistrationNumber: z.string().optional(),
      businessCountry: z.string().optional(),
      businessType: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [app] = await db.select().from(kycApplications)
        .where(eq(kycApplications.id, input.applicationId)).limit(1);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "KYC application not found" });
      assertTenantAccess(ctx.user, app.tenantId);
      const { applicationId, ...data } = input;
      await db.update(kycApplications)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(kycApplications.id, applicationId));

      // A3-F01: re-run KYB screening when business identity fields change and
      // persist the advisory recommendation into reviewNotes for reviewers.
      const merged = { ...app, ...data };
      let screenNote: string | null = null;
      try {
        const kyb = await runKybScreenFor(merged);
        if (kyb) {
          screenNote = kybNote(kyb);
          const prior = (app.reviewNotes ?? "").split("\n").filter((l) => !KYB_NOTE_RE.test(l));
          await db.update(kycApplications)
            .set({ reviewNotes: [...prior, screenNote].filter(Boolean).join("\n"), updatedAt: new Date() })
            .where(eq(kycApplications.id, applicationId));
        }
      } catch (err) {
        // Advisory pre-fill only; never block the merchant's draft save.
        console.error("[kyc.updateApplication] KYB screening failed:", err);
      }
      return { ok: true, kybScreen: screenNote };
    }),

  // Submit application for review
  submit: protectedProcedure
    .input(z.object({ applicationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [app] = await db.select().from(kycApplications)
        .where(eq(kycApplications.id, input.applicationId)).limit(1);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "KYC application not found" });
      assertTenantAccess(ctx.user, app.tenantId);
      // A3-F01: a persisted reject recommendation blocks submission.
      const kybRec = KYB_NOTE_RE.exec(app.reviewNotes ?? "")?.[1];
      if (kybRec === "reject") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Cannot submit: KYB screening returned a reject recommendation. Contact support.",
        });
      }
      await db.update(kycApplications)
        .set({ status: "pending", submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(kycApplications.id, input.applicationId));
      return { ok: true };
    }),

  // Upload a document and send it to the KYC microservice for OCR/VLM processing
  uploadDocument: protectedProcedure
    .input(z.object({
      applicationId: z.string(),
      documentType: z.enum(["national_id", "passport", "drivers_license", "residence_permit", "utility_bill", "bank_statement", "business_registration", "certificate_of_incorporation", "tax_certificate", "directors_id"]),
      fileBase64: z.string(), // base64-encoded file content
      mimeType: z.string().default("image/jpeg"),
      fileName: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // Ownership: resolve the application and require tenant access before
      // storing anything; also gives us the real tenantId for the document row.
      const [app] = await db.select().from(kycApplications)
        .where(eq(kycApplications.id, input.applicationId)).limit(1);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "KYC application not found" });
      assertTenantAccess(ctx.user, app.tenantId);
      // 1. Store file in S3
      const buffer = Buffer.from(input.fileBase64, "base64");
      const key = `kyc/${input.applicationId}/${input.documentType}-${Date.now()}`;
      const { url: fileUrl } = await storagePut(key, buffer, input.mimeType);
      // 2. Save document record
      const docId = randomUUID();
      await db.insert(kycDocuments).values({
        id: docId,
        applicationId: input.applicationId,
        tenantId: app.tenantId,
        documentType: input.documentType,
        fileUrl,
        fileKey: key,
        mimeType: input.mimeType,
        fileName: input.fileName,
        createdAt: new Date(),
      });
      // 3. Send to KYC microservice for processing (non-blocking, best-effort)
      let serviceResult: Record<string, unknown> = { queued: true };
      try {
        serviceResult = await callKycService("/verify/document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_id: docId,
            application_id: input.applicationId,
            document_type: input.documentType,
            file_url: fileUrl,
            mime_type: input.mimeType,
          }),
        });
        // Update document with extracted fields from OCR/VLM
        if (serviceResult.extracted_fields) {
          await db.update(kycDocuments)
            .set({ extractedData: serviceResult.extracted_fields as Record<string, unknown>, processedAt: new Date() })
            .where(eq(kycDocuments.id, docId));
        }
      } catch {
        // KYC service unavailable in dev — document is stored, will be processed on submit
        serviceResult = { queued: true, note: "KYC service offline — document queued for processing on submit" };
      }
      return { ok: true, documentId: docId, fileUrl, serviceResult };
    }),

  // Admin: list all applications
  listAll: adminProcedure
    .input(z.object({ status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = input.status
        ? [eq(kycApplications.status, input.status as KycApplication["status"])]
        : [];
      return db.select().from(kycApplications)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(kycApplications.createdAt))
        .limit(input.limit);
    }),

  // Admin: review application
  review: adminProcedure
    .input(z.object({
      applicationId: z.string(),
      decision: z.enum(["approved", "rejected", "resubmit_required"]),
      notes: z.string().optional(),
      rejectionReason: z.string().optional(),
      // W12.1 fail-closed gate: approving while documents are still
      // pending/processing requires this EXPLICIT waiver. The waiver is
      // recorded on each affected document (verificationNotes) and in
      // reviewNotes so the audit trail shows who waived and when.
      waivePendingDocuments: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const reviewer = ctx.user.name ?? ctx.user.email ?? "admin";

      // ── Document-verification gate (W12.1, fail closed) ─────────────────
      // An application may not reach 'approved' while any of its documents is
      // still awaiting OCR/VLM verification (processedAt unset = pending /
      // processing). Approving anyway requires the admin's explicit waiver,
      // which is recorded per document.
      let reviewNotes = input.notes;
      if (input.decision === "approved") {
        // ── KYB screening gate (A3-F01, fail closed) ──────────────────────
        // Approval is blocked when screening says reject, when the sanctions
        // list is degraded, or when screening errors — never auto-pass.
        const [app] = await db.select().from(kycApplications)
          .where(eq(kycApplications.id, input.applicationId)).limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "KYC application not found" });
        if (KYB_NOTE_RE.exec(app.reviewNotes ?? "")?.[1] === "reject") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Cannot approve: KYB screening recommendation is reject.",
          });
        }
        if (kybScreeningEnabled()) {
          let kyb: KybCheckResult | null = null;
          try {
            kyb = await runKybScreenFor(app);
          } catch (err) {
            console.error("[kyc.review] KYB screening error (fail-closed):", err);
          }
          if (!kyb || kyb.recommendation === "reject" || kyb.sanctions.degraded) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: kyb
                ? `Cannot approve: KYB screening requires manual resolution (${kyb.reasons.join("; ")})`
                : "Cannot approve: KYB screening unavailable (fail-closed).",
            });
          }
        }
        const docs = await db.select().from(kycDocuments)
          .where(eq(kycDocuments.applicationId, input.applicationId));
        const pendingDocs = docs.filter((d) => !d.processedAt);
        if (pendingDocs.length > 0) {
          if (!input.waivePendingDocuments) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                `Cannot approve: ${pendingDocs.length} document(s) are still pending verification ` +
                `(${pendingDocs.map((d) => d.documentType).join(", ")}). ` +
                "Wait for the OCR/VLM pipeline to finish, or re-review with waivePendingDocuments=true.",
            });
          }
          const waiverNote =
            `[doc-waiver] verification waived by admin ${reviewer} at ${new Date().toISOString()}`;
          for (const d of pendingDocs) {
            await db.update(kycDocuments)
              .set({ verificationNotes: [d.verificationNotes, waiverNote].filter(Boolean).join("\n") })
              .where(eq(kycDocuments.id, d.id));
          }
          reviewNotes = [input.notes, waiverNote].filter(Boolean).join("\n");
        }
      }

      await db.update(kycApplications).set({
        status: input.decision,
        reviewedBy: reviewer,
        reviewNotes,
        rejectionReason: input.rejectionReason,
        reviewedAt: new Date(),
        approvedAt: input.decision === "approved" ? new Date() : undefined,
        updatedAt: new Date(),
      }).where(eq(kycApplications.id, input.applicationId));
      return { ok: true };
    }),

  // Create liveness session via KYC Python service
  createLivenessSession: protectedProcedure
    .input(z.object({ applicationId: z.string(), tenantId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      try {
        const session = await callKycService("/liveness/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            application_id: input.applicationId,
            tenant_id: input.tenantId,
          }),
        });
        // Store session reference
        await db.insert(livenessChecks).values({
          id: randomUUID(),
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          status: "in_progress",
          sessionToken: session.session_id,
          challengeType: session.challenge?.type,
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 300_000),
        });
        return session;
      } catch (err) {
        // KYC liveness service unavailable — create a manual review session
        console.warn("[KYC] Liveness service unavailable, creating manual review session:", err);
        const fallbackSessionId = randomUUID();
        await db.insert(livenessChecks).values({
          id: randomUUID(),
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          status: "in_progress",
          sessionToken: fallbackSessionId,
          challengeType: "manual_review",
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000), // 24h for manual review
        });
        return {
          session_id: fallbackSessionId,
          challenge: {
            type: "manual_review",
            instruction: "Automated liveness verification is temporarily unavailable. Our compliance team will review your documents manually within 24 hours.",
            required_frames: 0,
          },
          expires_in: 86400,
          manual_review: true,
          service_unavailable: true,
        };
      }
    }),

  // Get KYC stats for dashboard
  stats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { total: 0, pending: 0, approved: 0, rejected: 0, underReview: 0 };
    const apps = await db.select().from(kycApplications);
    return {
      total: apps.length,
      pending: apps.filter(a => a.status === "pending").length,
      approved: apps.filter(a => a.status === "approved").length,
      rejected: apps.filter(a => a.status === "rejected").length,
      underReview: apps.filter(a => a.status === "under_review").length,
    };
  }),
});
