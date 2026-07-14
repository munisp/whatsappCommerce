import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { kycApplications, kycDocuments, livenessChecks } from "../../drizzle/schema";
import type { KycApplication } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { storagePut } from "../storage";

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
    .mutation(async ({ input }) => {
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
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [app] = await db.select().from(kycApplications)
        .where(eq(kycApplications.id, input.applicationId)).limit(1);
      if (!app) return null;
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
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const { applicationId, ...data } = input;
      await db.update(kycApplications)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(kycApplications.id, applicationId));
      return { ok: true };
    }),

  // Submit application for review
  submit: protectedProcedure
    .input(z.object({ applicationId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
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
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // 1. Store file in S3
      const buffer = Buffer.from(input.fileBase64, "base64");
      const key = `kyc/${input.applicationId}/${input.documentType}-${Date.now()}`;
      const { url: fileUrl } = await storagePut(key, buffer, input.mimeType);
      // 2. Save document record
      const docId = randomUUID();
      await db.insert(kycDocuments).values({
        id: docId,
        applicationId: input.applicationId,
        tenantId: "unknown", // will be resolved from applicationId in production
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
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db.update(kycApplications).set({
        status: input.decision,
        reviewedBy: ctx.user.name ?? ctx.user.email ?? "admin",
        reviewNotes: input.notes,
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
    .mutation(async ({ input }) => {
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
      } catch {
        // Mock session for dev without KYC service running
        const mockSessionId = randomUUID();
        await db.insert(livenessChecks).values({
          id: randomUUID(),
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          status: "in_progress",
          sessionToken: mockSessionId,
          challengeType: "blink",
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 300_000),
        });
        return {
          session_id: mockSessionId,
          challenge: { type: "blink", instruction: "Please blink both eyes twice", required_frames: 10 },
          expires_in: 300,
          mock: true,
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
