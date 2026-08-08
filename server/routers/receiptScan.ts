import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { analyzeReceiptImage } from "../services/receiptVision";

// AI receipt scanning — vision LLM extracts text and validates image clarity.
// The vision core lives in services/receiptVision.ts so the WhatsApp inbound
// receipt-verification pipeline uses the exact same analysis.
export const receiptScanRouter = router({
  // Public procedure: called from the evidence portal (no auth required)
  scanImage: publicProcedure
    .input(z.object({
      imageBase64: z.string().min(100, "Image data too short"),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    }))
    .mutation(async ({ input }) => {
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
