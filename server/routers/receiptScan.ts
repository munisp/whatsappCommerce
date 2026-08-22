import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../db";
import { disputeEvidenceTokens } from "../../drizzle/schema";
import { analyzeReceiptImage } from "../services/receiptVision";

// AI receipt scanning — vision LLM extracts text and validates image clarity.
// The vision core lives in services/receiptVision.ts so the WhatsApp inbound
// receipt-verification pipeline uses the exact same analysis.
//
// W26 security: this calls a paid vision LLM, so it is no longer an open
// public endpoint. Callers must EITHER be authenticated (merchant console)
// OR present a valid, unexpired evidence-portal token (the /evidence/:token
// link shared with a buyer during a dispute).
export const receiptScanRouter = router({
  scanImage: publicProcedure
    .input(z.object({
      imageBase64: z.string().min(100, "Image data too short"),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      // Evidence-portal capability token (buyer flow). Authenticated users
      // (merchant console) do not need it.
      evidenceToken: z.string().min(16).max(128).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        if (!input.evidenceToken) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication or a valid evidence link is required" });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const [tok] = await db
          .select({ id: disputeEvidenceTokens.id })
          .from(disputeEvidenceTokens)
          .where(and(
            eq(disputeEvidenceTokens.token, input.evidenceToken),
            gt(disputeEvidenceTokens.expiresAt, new Date()),
          ))
          .limit(1);
        if (!tok) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired evidence link" });
        }
      }
      try {
        const result = await analyzeReceiptImage(input.imageBase64, input.mimeType);
        return { success: true, ...result };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error && err.message === "Failed to parse AI response"
            ? "Failed to parse AI response"
            : `AI scan failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
});
