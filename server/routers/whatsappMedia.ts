import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { whatsappMediaFiles } from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import { storagePut, storageGet } from "../storage";
import { invokeLLM } from "../_core/llm";

// ── Document type detection ───────────────────────────────────────────────────
const MIME_HINTS: Record<string, string> = {
  "application/pdf": "document",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "text/csv": "spreadsheet",
};

function detectDocumentType(fileName: string, mimeType: string): string {
  const name = fileName.toLowerCase();
  if (name.includes("purchase_order") || name.includes("po_") || name.includes("_po.")) return "purchase_order";
  if (name.includes("invoice") || name.includes("inv_")) return "invoice";
  if (name.includes("receipt") || name.includes("rcpt")) return "receipt";
  if (name.includes("delivery") || name.includes("waybill") || name.includes("pod")) return "delivery_note";
  if (name.includes("contract") || name.includes("agreement")) return "contract";
  if (MIME_HINTS[mimeType] === "image") return "image";
  if (MIME_HINTS[mimeType] === "spreadsheet") return "spreadsheet";
  return "other";
}

export const whatsappMediaRouter = router({
  /** Upload a document/image from WhatsApp (base64 encoded) */
  upload: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      conversationId: z.string().optional(),
      waPhoneNumber: z.string().optional(),
      fileName: z.string(),
      mimeType: z.string(),
      fileBase64: z.string(), // base64-encoded file content
      fileSize: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const buf = Buffer.from(input.fileBase64, "base64");
      const fileId = crypto.randomUUID();
      const storageKey = `whatsapp-media/${input.tenantId}/${fileId}-${input.fileName}`;
      const { url } = await storagePut(storageKey, buf, input.mimeType);
      const documentType = detectDocumentType(input.fileName, input.mimeType);
      // Run AI scan for images and PDFs to extract key fields
      let aiScanResult: Record<string, unknown> | null = null;
      if (input.mimeType.startsWith("image/")) {
        try {
          const raw = await invokeLLM({
            model: "gpt-5-mini",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Extract key fields from this document image. Return JSON with: { documentType, vendor, buyer, amount, currency, date, items: [{description, qty, unitPrice}], notes }. If a field is not present, omit it." },
                { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${input.fileBase64}` } }
              ]
            }]
          });
          const content = raw.choices?.[0]?.message?.content ?? "{}";
          const cleaned = (typeof content === "string" ? content : "{}").replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
          aiScanResult = JSON.parse(cleaned);
        } catch { /* scan failed — continue without */ }
      }
      const [record] = await db.insert(whatsappMediaFiles).values({
        id: fileId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        waPhoneNumber: input.waPhoneNumber,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        storageKey,
        storageUrl: url,
        documentType,
        aiScanResult,
        uploadedAt: new Date(),
      }).returning();
      return record;
    }),

  /** List media files for a tenant, optionally filtered by conversation */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      conversationId: z.string().optional(),
      documentType: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(whatsappMediaFiles.tenantId, input.tenantId)];
      if (input.conversationId) conditions.push(eq(whatsappMediaFiles.conversationId, input.conversationId));
      if (input.documentType) conditions.push(eq(whatsappMediaFiles.documentType, input.documentType));
      return db.select().from(whatsappMediaFiles)
        .where(and(...conditions))
        .orderBy(desc(whatsappMediaFiles.uploadedAt))
        .limit(input.limit);
    }),

  /** Get a fresh presigned download URL for a media file */
  getDownloadUrl: protectedProcedure
    .input(z.object({ fileId: z.string(), tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [file] = await db.select().from(whatsappMediaFiles)
        .where(and(eq(whatsappMediaFiles.id, input.fileId), eq(whatsappMediaFiles.tenantId, input.tenantId)))
        .limit(1);
      if (!file) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
      const { url } = await storageGet(file.storageKey, 3600);
      return { url, file };
    }),

  /** Toggle USSD mode for an NLP session (stores in context jsonb) */
  setUssdMode: protectedProcedure
    .input(z.object({ tenantId: z.string(), waPhoneNumber: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { nlpSessions } = await import("../../drizzle/schema");
      const [session] = await db.select().from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, input.tenantId), eq(nlpSessions.waPhoneNumber, input.waPhoneNumber)))
        .limit(1);
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      const ctx = (session.context as Record<string, unknown>) ?? {};
      ctx.ussdMode = input.enabled;
      await db.update(nlpSessions).set({ context: ctx }).where(eq(nlpSessions.id, session.id));
      return { success: true, ussdMode: input.enabled };
    }),

  /** Update SMS failover flag for a tenant */
  setSmsFailover: protectedProcedure
    .input(z.object({ tenantId: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { tenants } = await import("../../drizzle/schema");
      await db.update(tenants)
        .set({ smsFailoverEnabled: input.enabled, updatedAt: new Date() })
        .where(eq(tenants.id, input.tenantId));
      return { success: true, smsFailoverEnabled: input.enabled };
    }),
});
