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
 *   4. Compares the parsed amount to the order total (±₦100 tolerance):
 *      - MATCH   → confirms the payment through the SAME shared confirmation
 *                  path as the Paystack/Flutterwave webhooks
 *                  (services/paymentConfirm.ts — money logic is never
 *                  duplicated) and replies with a confirmation.
 *      - NO MATCH → flags the order metadata receiptReview:true and replies
 *                  that the receipt is queued for manual review.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { customers, orders, paymentTransactions } from "../../drizzle/schema";
import { analyzeReceiptImage, parseReceiptAmount, receiptAmountMatches } from "./receiptVision";
import { confirmProviderPayment } from "./paymentConfirm";
import { resolveTenantWaCredentials, sendWhatsAppText } from "./waSender";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Major-unit tolerance between the receipt amount and the order total (₦100). */
export const RECEIPT_AMOUNT_TOLERANCE = 100;

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

  // 3. Amount match within tolerance → confirm through the shared path.
  if (parsedAmount != null && receiptAmountMatches(parsedAmount, orderTotal, RECEIPT_AMOUNT_TOLERANCE)) {
    const [tx] = await db.select().from(paymentTransactions)
      .where(and(eq(paymentTransactions.orderId, order.id), eq(paymentTransactions.status, "initiated")))
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(1);

    if (tx?.providerRef) {
      // The receipt matched within tolerance; confirm at the order's expected
      // amount (the parsed amount is recorded in rawPayload for audit).
      const result = await confirmProviderPayment(db, {
        provider: tx.provider ?? "manual",
        reference: tx.providerRef,
        amountMajor: orderTotal,
        currency: tx.currency ?? order.currency,
        rawPayload: {
          source: "wa_receipt_scan",
          mediaId: opts.mediaId,
          parsedAmount,
          scanSummary: scan.summary,
          scanConfidence: scan.confidence,
        },
      });
      if (result.ok) {
        await reply(
          `✅ Payment received for order ${order.orderNumber} (${fmt(orderTotal)}). ` +
          `Your payment is confirmed and your order is being prepared. 🎉`,
        );
        return { handled: true, outcome: "confirmed", orderId: order.id };
      }
      // Shared path rejected (e.g. already-completed is fine; a real mismatch
      // there means something inconsistent) — fall through to manual review.
      if (result.action === "already-completed") {
        await reply(`✅ Order ${order.orderNumber} is already confirmed and being prepared. 🎉`);
        return { handled: true, outcome: "confirmed", orderId: order.id };
      }
    }
    // No initiatable payment row (e.g. pure bank-transfer tenant) — a human
    // must record this payment; flag for review rather than bypassing the
    // shared money path.
    await flagReceiptReview(db, order.id, {
      receiptReviewReason: "no-payment-transaction",
      receiptMediaId: opts.mediaId,
      parsedAmount,
    });
    await reply(
      `🧾 Thanks! Your receipt for order ${order.orderNumber} (${fmt(parsedAmount ?? 0)}) matches the expected amount, ` +
      `but needs a manual confirmation from the store. We'll confirm shortly.`,
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
