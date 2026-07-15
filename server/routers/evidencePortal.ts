import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  disputeEvidenceTokens,
  disputeEvidenceSubmissions,
  escrowDisputes,
  escrowTransactions,
} from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { storagePut } from "../storage";
import { emitNotification } from "./notifications";

// ─── Generate a cryptographically secure token ────────────────────────────────
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── tRPC router (authenticated — for merchants/admins) ───────────────────────
export const evidencePortalRouter = router({
  // Generate a token link for a buyer to submit evidence
  generateToken: protectedProcedure
    .input(z.object({
      disputeId: z.string(),
      buyerPhone: z.string().optional(),
      buyerName: z.string().optional(),
      expiryHours: z.number().int().min(1).max(168).default(72),
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify the dispute belongs to this tenant
      const disputes = await db
        .select()
        .from(escrowDisputes)
        .where(and(eq(escrowDisputes.id, input.disputeId), eq(escrowDisputes.tenantId, tenantId)));
      if (!disputes.length) throw new TRPCError({ code: "NOT_FOUND", message: "Dispute not found" });

      const token = generateToken();
      const expiresAt = new Date(Date.now() + input.expiryHours * 60 * 60 * 1000);

      await db.insert(disputeEvidenceTokens).values({
        id: crypto.randomUUID(),
        token,
        disputeId: input.disputeId,
        buyerPhone: input.buyerPhone,
        buyerName: input.buyerName,
        expiresAt,
      });

      const portalUrl = `/evidence/${token}`;
      return { token, portalUrl, expiresAt };
    }),

  // List all tokens for a dispute
  listTokens: protectedProcedure
    .input(z.object({ disputeId: z.string() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(disputeEvidenceTokens)
        .where(eq(disputeEvidenceTokens.disputeId, input.disputeId));
    }),

  // List all evidence submissions for a dispute (admin/merchant view)
  listSubmissions: protectedProcedure
    .input(z.object({ disputeId: z.string() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) return [];
      // Verify dispute belongs to tenant
      const disputes = await db
        .select()
        .from(escrowDisputes)
        .where(and(eq(escrowDisputes.id, input.disputeId), eq(escrowDisputes.tenantId, tenantId)));
      if (!disputes.length) throw new TRPCError({ code: "NOT_FOUND" });
      return db
        .select()
        .from(disputeEvidenceSubmissions)
        .where(eq(disputeEvidenceSubmissions.disputeId, input.disputeId));
    }),

  // Revoke a token (invalidate it)
  revokeToken: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(disputeEvidenceTokens)
        .set({ usedAt: new Date() })
        .where(eq(disputeEvidenceTokens.token, input.token));
      return { success: true };
    }),
});

// ─── Public handlers (no auth — called from Express, not tRPC) ───────────────
// These are registered as raw Express routes in index.ts

export async function handleGetEvidencePortal(token: string): Promise<{
  valid: boolean;
  expired?: boolean;
  dispute?: {
    id: string;
    orderId: string | null;
    amount: string;
    currency: string;
    status: string;
    raisedAt: Date;
    buyerName: string | null;
  };
  existingSubmissions?: Array<{
    id: string;
    filename: string | null;
    note: string | null;
    submittedAt: Date;
    hasFile: boolean;
  }>;
}> {
  const db = await getDb();
  if (!db) return { valid: false };

  const tokens = await db
    .select()
    .from(disputeEvidenceTokens)
    .where(eq(disputeEvidenceTokens.token, token));
  if (!tokens.length) return { valid: false };

  const tokenRecord = tokens[0];
  if (new Date(tokenRecord.expiresAt) < new Date()) return { valid: false, expired: true };

    const disputes = await db
      .select()
      .from(escrowDisputes)
      .where(eq(escrowDisputes.id, tokenRecord.disputeId));
    if (!disputes.length) return { valid: false };
    const dispute = disputes[0];

    // Get the escrow transaction for amount/currency
    const escrows = await db
      .select()
      .from(escrowTransactions)
      .where(eq(escrowTransactions.id, dispute.escrowTxId));
  const escrow = escrows[0];

  // Get existing submissions
  const submissions = await db
    .select()
    .from(disputeEvidenceSubmissions)
    .where(eq(disputeEvidenceSubmissions.disputeId, dispute.id));

    return {
      valid: true,
      dispute: {
        id: dispute.id,
        orderId: escrow?.orderId ?? null,
        amount: escrow?.amount ?? "0",
        currency: escrow?.currency ?? "NGN",
        status: dispute.status,
        raisedAt: dispute.createdAt,
        buyerName: tokenRecord.buyerName,
      },
    existingSubmissions: submissions.map((s) => ({
      id: s.id,
      filename: s.filename,
      note: s.note,
      submittedAt: s.submittedAt,
      hasFile: !!s.fileUrl,
    })),
  };
}

export async function handleSubmitEvidence(
  token: string,
  note: string | null,
  fileBuffer: Buffer | null,
  filename: string | null,
  mimeType: string | null
): Promise<{ success: boolean; submissionId?: string; error?: string }> {
  const db = await getDb();
  if (!db) return { success: false, error: "Service unavailable" };

  const tokens = await db
    .select()
    .from(disputeEvidenceTokens)
    .where(eq(disputeEvidenceTokens.token, token));
  if (!tokens.length) return { success: false, error: "Invalid or expired link" };

  const tokenRecord = tokens[0];
  if (new Date(tokenRecord.expiresAt) < new Date()) return { success: false, error: "This link has expired" };

  let fileUrl: string | null = null;
  let fileKey: string | null = null;

  if (fileBuffer && filename && mimeType) {
    const key = `evidence/${tokenRecord.disputeId}/${crypto.randomUUID()}-${filename}`;
    const result = await storagePut(key, fileBuffer, mimeType);
    fileUrl = result.url;
    fileKey = result.key;
  }

  const submissionId = crypto.randomUUID();
  await db.insert(disputeEvidenceSubmissions).values({
    id: submissionId,
    disputeId: tokenRecord.disputeId,
    token,
    fileUrl,
    fileKey,
    filename,
    mimeType,
    note,
  });

  // Mark token as used (single-use after first submission)
  await db
    .update(disputeEvidenceTokens)
    .set({ usedAt: new Date() })
    .where(eq(disputeEvidenceTokens.token, token));

  // Notify the merchant
  const disputes = await db
    .select()
    .from(escrowDisputes)
    .where(eq(escrowDisputes.id, tokenRecord.disputeId));
  if (disputes.length > 0) {
    await emitNotification({
      id: crypto.randomUUID(),
      tenantId: disputes[0].tenantId,
      type: "dispute_opened",
      title: "Buyer Submitted Dispute Evidence",
      body: `New evidence submitted for dispute on order. ${filename ? `File: ${filename}` : ""} ${note ? `Note: ${note.slice(0, 80)}` : ""}`.trim(),
      metadata: { disputeId: tokenRecord.disputeId, submissionId },
      read: false,
    });
  }

  return { success: true, submissionId };
}
