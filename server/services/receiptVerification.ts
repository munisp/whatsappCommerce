/**
 * Receipt-screenshot payment verification.
 *
 * When a buyer with a recent unpaid order sends an image to the business
 * WhatsApp number, this pipeline (triggered async from the webhook media
 * handler — never blocking the 200 ack):
 *
 *   1. Finds the buyer's most recent pending order (last 24h).
 *   2. Downloads the media from the WhatsApp Graph API (tenant credentials).
 *   3. Runs the shared receipt vision analysis (services/receiptVision.ts —
 *      the same core as the evidence-portal scanner).
 *   4. Compares the parsed amount to the order total (EXACT minor-unit
 *      match — zero tolerance, Wave 26 audit F2).
 *
 *      WAVE 26 AUDIT F2 (CRITICAL): an OCR receipt scan ALONE must NEVER
 *      auto-confirm a payment. OCR output is attacker-controlled pixels, not
 *      money movement. Every receipt — matching amount or not — is flagged
 *      receiptReview:true and queued for HUMAN review; payment confirmation
 *      only ever happens through the provider webhook / provider fetchStatus
 *      paths (services/paymentConfirm.ts). The auto-confirm branch that
 *      previously called confirmProviderPayment from here was removed.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { customers, orders } from "../../drizzle/schema";
import { analyzeReceiptImage, parseReceiptAmount, receiptAmountMatches } from "./receiptVision";
import { resolveTenantWaCredentials, sendWhatsAppText } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Tolerance between the receipt amount and the order total: ZERO (Wave 26
 * audit F2) — only an exact minor-unit match counts, and even an exact match
 * never auto-confirms (human review required).
 */
export const RECEIPT_AMOUNT_TOLERANCE = 0;

/** Find the buyer's most recent order awaiting payment (last 24h). */
export async function findRecentUnpaidOrder(
  db: Db,
  tenantId: string,
  waPhoneNumber: string,
): Promise<any | null> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const phoneDigits = waPhoneNumber.replace(/[^\d]/g, "");

  // Chat orders store the raw WA number in orders.customerId.
  const direct = await db.select().from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, waPhoneNumber),
      eq(orders.status, "pending"),
      gte(orders.createdAt, since),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  if (direct[0] && direct[0].paymentStatus !== "completed") return direct[0];

  // Back-office orders: resolve through the customers row.
  const [customer] = await db.select().from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phoneDigits)))
    .limit(1)
    .catch(() => []);
  if (!customer) return direct[0] ?? null;

  const viaCustomer = await db.select().from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customer.id),
      eq(orders.status, "pending"),
      gte(orders.createdAt, since),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  const found = viaCustomer[0] ?? direct[0] ?? null;
  if (found && found.paymentStatus === "completed") return null;
  return found;
}

/** Download a WhatsApp media object and return it base64-encoded. */
async function downloadWaMedia(tenantId: string, mediaId: string): Promise<{ base64: string; mimeType: string } | null> {
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(20000),
  }).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return {
    base64: Buffer.from(bin).toString("base64"),
    mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "image/jpeg",
  };
}

async function flagReceiptReview(db: Db, orderId: string, patch: Record<string, unknown>): Promise<void> {
  await db.update(orders).set({
    metadata: sql`COALESCE(${orders.metadata}, '{}'::jsonb) || ${JSON.stringify({ receiptReview: true, ...patch })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(orders.id, orderId));
}

export interface ReceiptVerifyOutcome {
  handled: boolean;
  outcome?: "confirmed" | "manual_review" | "no_pending_order" | "download_failed";
  orderId?: string;
}

/**
 * Full pipeline for one inbound image. Exported for tests; the webhook calls
 * it fire-and-forget with .catch(console).
 */
export async function handleInboundReceiptImage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
}): Promise<ReceiptVerifyOutcome> {
  const db = await getDb();
  if (!db) return { handled: false };

  const order = await findRecentUnpaidOrder(db, opts.tenantId, opts.waPhoneNumber);
  if (!order) return { handled: true, outcome: "no_pending_order" };

  const reply = (body: string) =>
    sendWhatsAppText(opts.tenantId, opts.waPhoneNumber, body, {
      notifType: "receipt_verification",
      orderId: order.id,
    });

  const orderTotal = Number(order.totalAmount);
  const fmt = (n: number) => `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

  // 1. Download the image from the Graph API.
  const media = await downloadWaMedia(opts.tenantId, opts.mediaId);
  if (!media) {
    await flagReceiptReview(db, order.id, { receiptReviewReason: "media-download-unavailable", receiptMediaId: opts.mediaId });
    await reply(
      `🧾 Thanks! We received your receipt for order ${order.orderNumber} but couldn't process the image automatically. ` +
      `It's queued for manual review — we'll confirm your payment shortly.`,
    );
    return { handled: true, outcome: "download_failed", orderId: order.id };
  }

  // 2. Vision scan.
  const mime = (["image/jpeg", "image/png", "image/webp"].includes(media.mimeType) ? media.mimeType : "image/jpeg") as
    "image/jpeg" | "image/png" | "image/webp";
  const scan = await analyzeReceiptImage(media.base64, mime);
  const parsedAmount =
    parseReceiptAmount(scan.keyFields?.amount) ?? parseReceiptAmount(scan.extractedText);

  // 3. Exact amount match → STILL manual review (Wave 26 audit F2). An OCR
  // scan never confirms a payment by itself; a human (or the provider
  // webhook / fetchStatus path) must verify real money movement.
  if (parsedAmount != null && receiptAmountMatches(parsedAmount, orderTotal, RECEIPT_AMOUNT_TOLERANCE)) {
    await flagReceiptReview(db, order.id, {
      receiptReviewReason: "amount-match-awaiting-human-review",
      receiptMediaId: opts.mediaId,
      parsedAmount,
      expectedAmount: orderTotal,
      scanSummary: scan.summary,
      scanConfidence: scan.confidence,
    });
    await reply(
      `🧾 Thanks! Your receipt for order ${order.orderNumber} (${fmt(parsedAmount)}) matches the expected amount. ` +
      `It's queued for a final confirmation from the store — we'll confirm shortly.`,
    );
    return { handled: true, outcome: "manual_review", orderId: order.id };
  }

  // 4. No match → manual review.
  await flagReceiptReview(db, order.id, {
    receiptReviewReason: parsedAmount == null ? "amount-not-found" : "amount-mismatch",
    receiptMediaId: opts.mediaId,
    parsedAmount,
    expectedAmount: orderTotal,
    scanSummary: scan.summary,
  });
  await reply(
    parsedAmount == null
      ? `🧾 Thanks! We received your receipt for order ${order.orderNumber} but couldn't read the amount. It's queued for manual review — we'll confirm shortly.`
      : `🧾 Thanks! Your receipt shows ${fmt(parsedAmount)} but order ${order.orderNumber} totals ${fmt(orderTotal)}. It's queued for manual review — we'll sort it out and confirm shortly.`,
  );
  return { handled: true, outcome: "manual_review", orderId: order.id };
}
