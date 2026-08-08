/**
 * Receipt/document vision analysis — the vision-LLM core shared by the
 * evidence-portal scan endpoint (routers/receiptScan.ts) and the WhatsApp
 * inbound receipt-screenshot verification pipeline
 * (services/receiptVerification.ts).
 */

import { invokeLLM } from "../_core/llm";

export interface ReceiptScanResult {
  isReadable: boolean;
  clarityScore: number;
  clarityIssues: string[];
  documentType: string;
  extractedText: string;
  keyFields: Record<string, string>;
  confidence: number;
  summary: string;
}

/**
 * Analyse a receipt/document image with the vision LLM.
 * @throws Error when the model call fails or returns unparseable output.
 */
export async function analyzeReceiptImage(
  imageBase64: string,
  mimeType: "image/jpeg" | "image/png" | "image/webp",
): Promise<ReceiptScanResult> {
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const response = await invokeLLM({
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

  const content = response?.choices?.[0]?.message?.content;
  if (!content) throw new Error("No response from AI model");

  let result: any;
  try {
    result = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw new Error("Failed to parse AI response");
  }

  return {
    isReadable: Boolean(result.isReadable),
    clarityScore: Number(result.clarityScore ?? 0),
    clarityIssues: (result.clarityIssues ?? []) as string[],
    documentType: String(result.documentType ?? "unknown"),
    extractedText: String(result.extractedText ?? ""),
    keyFields: (result.keyFields ?? {}) as Record<string, string>,
    confidence: Number(result.confidence ?? 0),
    summary: String(result.summary ?? ""),
  };
}

/**
 * Parse a Naira (or plain) amount out of free receipt text: handles
 * "₦12,500", "NGN 12500.00", "12,500.00". Returns major units or null.
 */
export function parseReceiptAmount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).match(/(?:₦|NGN|N)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** ±tolerance comparison between a receipt amount and an order total. */
export function receiptAmountMatches(receiptAmount: number, orderTotal: number, tolerance = 100): boolean {
  return Math.abs(receiptAmount - orderTotal) <= tolerance;
}
