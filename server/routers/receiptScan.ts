import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { TRPCError } from "@trpc/server";

// AI receipt scanning — vision LLM extracts text and validates image clarity
export const receiptScanRouter = router({
  // Public procedure: called from the evidence portal (no auth required)
  scanImage: publicProcedure
    .input(z.object({
      imageBase64: z.string().min(100, "Image data too short"),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    }))
    .mutation(async ({ input }) => {
      const dataUrl = `data:${input.mimeType};base64,${input.imageBase64}`;

      let response;
      try {
        response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are a receipt and document analysis assistant. Your job is to:
1. Assess image clarity (blurry, dark, cropped, or unreadable images should be flagged).
2. Extract all visible text from the image.
3. Identify if this looks like a receipt, invoice, delivery confirmation, or other proof-of-delivery document.
4. Extract key fields if present: date, amount, order number, seller name, buyer name, delivery address, tracking number.
Always respond with valid JSON only.`,
            },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: dataUrl, detail: "high" },
                },
                {
                  type: "text",
                  text: `Analyse this image and respond with JSON in this exact format:
{
  "isReadable": true or false,
  "clarityScore": 0-100 (100 = crystal clear),
  "clarityIssues": ["blurry", "too dark", "cropped", etc] or [],
  "documentType": "receipt" | "invoice" | "delivery_confirmation" | "screenshot" | "photo" | "other" | "unknown",
  "extractedText": "all visible text here",
  "keyFields": {
    "date": "...",
    "amount": "...",
    "orderNumber": "...",
    "sellerName": "...",
    "buyerName": "...",
    "deliveryAddress": "...",
    "trackingNumber": "..."
  },
  "confidence": 0-100,
  "summary": "one sentence summary of what this document shows"
}`,
                },
              ],
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "receipt_scan_result",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  isReadable: { type: "boolean" },
                  clarityScore: { type: "number" },
                  clarityIssues: { type: "array", items: { type: "string" } },
                  documentType: { type: "string" },
                  extractedText: { type: "string" },
                  keyFields: {
                    type: "object",
                    properties: {
                      date: { type: "string" },
                      amount: { type: "string" },
                      orderNumber: { type: "string" },
                      sellerName: { type: "string" },
                      buyerName: { type: "string" },
                      deliveryAddress: { type: "string" },
                      trackingNumber: { type: "string" },
                    },
                    required: ["date", "amount", "orderNumber", "sellerName", "buyerName", "deliveryAddress", "trackingNumber"],
                    additionalProperties: false,
                  },
                  confidence: { type: "number" },
                  summary: { type: "string" },
                },
                required: ["isReadable", "clarityScore", "clarityIssues", "documentType", "extractedText", "keyFields", "confidence", "summary"],
                additionalProperties: false,
              },
            },
          },
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `AI scan failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const content = response?.choices?.[0]?.message?.content;
      if (!content) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No response from AI model" });
      }

      try {
        const result = typeof content === "string" ? JSON.parse(content) : content;
        return {
          success: true,
          isReadable: result.isReadable as boolean,
          clarityScore: result.clarityScore as number,
          clarityIssues: result.clarityIssues as string[],
          documentType: result.documentType as string,
          extractedText: result.extractedText as string,
          keyFields: result.keyFields as Record<string, string>,
          confidence: result.confidence as number,
          summary: result.summary as string,
        };
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to parse AI response" });
      }
    }),
});

