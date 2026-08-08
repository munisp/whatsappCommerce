/**
 * Settlement recon auto-match.
 *
 * Bank/settlement data arrives from the recon-worker (Rust) or bank feeds via
 * POST /api/internal/recon-settlements (HMAC-verified). Each settlement is
 * matched against UNSETTLED receipts — orders still flagged
 * metadata.receiptReview = true (set by the receipt-verification pipeline when
 * a buyer's receipt could not be auto-confirmed) — by amount (±₦100, the same
 * tolerance as receiptVerification) and recency (most recent match within
 * 72h).
 *
 * A matched settlement is confirmed through the SHARED money path
 * (services/paymentConfirm.ts — confirmProviderPayment). Recon NEVER bypasses
 * paymentConfirm: it drives order confirmation, escrow hold creation and the
 * integration outbox exactly like a provider webhook. On success the buyer
 * and the tenant admin are notified and the receiptReview flag is cleared.
 * Unmatched settlements stay flagged for manual review.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { orders, paymentTransactions, tenants, customers } from "../../drizzle/schema";
import { confirmProviderPayment } from "./paymentConfirm";
import { sendWhatsAppText } from "./waSender";
import { RECEIPT_AMOUNT_TOLERANCE } from "./receiptVerification";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** A settlement is only auto-matched to a receipt flagged within this window. */
export const RECON_MATCH_WINDOW_HOURS = 72;

export interface SettlementInput {
  tenantId: string;
  /** Settled amount in MAJOR currency units. */
  amount: number;
  currency?: string;
  reference?: string;
  settledAt?: string;
}

export interface SettlementMatchResult {
  tenantId: string;
  amount: number;
  reference?: string;
  outcome: "confirmed" | "unmatched" | "invalid" | "error";
  orderId?: string;
  detail?: string;
}

async function resolveBuyerPhoneForOrder(db: Db, order: any): Promise<string | null> {
  const cid: string = order.customerId ?? "";
  if (/^\+?\d{7,15}$/.test(cid)) return cid.replace(/^\+/, "");
  if (!cid) return null;
  const [customer] = await db.select().from(customers).where(eq(customers.id, cid)).limit(1).catch(() => []);
  return customer?.whatsappPhone ?? null;
}

function adminPhoneFromSettings(settings: unknown): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

/**
 * Match one settlement against the tenant's flagged receipts and confirm the
 * best candidate via the shared payment-confirmation path.
 */
export async function matchSettlement(db: Db, s: SettlementInput): Promise<SettlementMatchResult> {
  const base = { tenantId: s.tenantId, amount: s.amount, reference: s.reference };
  if (!s.tenantId || !Number.isFinite(s.amount) || s.amount <= 0) {
    return { ...base, outcome: "invalid", detail: "tenantId and a positive amount are required" };
  }

  const since = new Date(Date.now() - RECON_MATCH_WINDOW_HOURS * 3600 * 1000);
  // Unsettled flagged receipts: receiptReview=true, payment not completed,
  // amount within the shared ±₦100 tolerance, most recent first.
  const candidates = await db.select().from(orders)
    .where(and(
      eq(orders.tenantId, s.tenantId),
      sql`(${orders.metadata}->>'receiptReview') = 'true'`,
      sql`${orders.paymentStatus} <> 'completed'`,
      sql`abs(${orders.totalAmount}::numeric - ${s.amount}) <= ${RECEIPT_AMOUNT_TOLERANCE}`,
      gte(orders.createdAt, since),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1);

  const order = candidates[0];
  if (!order) return { ...base, outcome: "unmatched" };

  // Confirm through the SAME shared path as provider webhooks / receipt scans.
  const [tx] = await db.select().from(paymentTransactions)
    .where(and(eq(paymentTransactions.orderId, order.id), eq(paymentTransactions.status, "initiated")))
    .orderBy(desc(paymentTransactions.createdAt))
    .limit(1);
  if (!tx?.providerRef) {
    // No payment instrument to confirm against — a human must record it.
    return { ...base, outcome: "unmatched", orderId: order.id, detail: "no-initiated-payment-transaction" };
  }

  const orderTotal = Number(order.totalAmount);
  const result = await confirmProviderPayment(db, {
    provider: tx.provider ?? "recon",
    reference: tx.providerRef,
    amountMajor: orderTotal,
    currency: tx.currency ?? order.currency,
    rawPayload: {
      source: "recon_settlement",
      settlementReference: s.reference ?? null,
      settledAt: s.settledAt ?? null,
      settledAmount: s.amount,
    },
  });
  if (!result.ok && result.action !== "already-completed") {
    return { ...base, outcome: "error", orderId: order.id, detail: result.action };
  }

  // Clear the review flag (audit trail preserved in metadata).
  await db.update(orders).set({
    metadata: sql`COALESCE(${orders.metadata}, '{}'::jsonb) || ${JSON.stringify({
      receiptReview: false,
      receiptReviewResolved: "recon_auto_match",
      reconSettlementReference: s.reference ?? null,
      reconMatchedAt: new Date().toISOString(),
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(orders.id, order.id));

  // Notify buyer + admin (best-effort — never fail the match on a send error).
  const fmt = (n: number) => `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  try {
    const buyerPhone = await resolveBuyerPhoneForOrder(db, order);
    if (buyerPhone) {
      await sendWhatsAppText(order.tenantId, buyerPhone,
        `✅ Your bank payment of ${fmt(s.amount)} for order ${order.orderNumber} has been matched and confirmed. Your order is being prepared. 🎉`,
        { notifType: "recon_payment_confirmed", orderId: order.id });
    }
    const [tenant] = await db.select({ settings: tenants.settings }).from(tenants)
      .where(eq(tenants.id, order.tenantId)).limit(1).catch(() => []);
    const adminPhone = adminPhoneFromSettings(tenant?.settings);
    if (adminPhone) {
      await sendWhatsAppText(order.tenantId, adminPhone,
        `✅ Recon auto-match: settlement ${s.reference ?? "(no ref)"} of ${fmt(s.amount)} confirmed order ${order.orderNumber}. No action needed.`,
        { notifType: "recon_admin_alert", orderId: order.id });
    }
  } catch (e: any) {
    console.warn("[recon-match] notification failed:", e?.message);
  }

  console.log(`[recon-match] settlement ${s.reference ?? "?"} (${s.amount}) confirmed order ${order.id}`);
  return { ...base, outcome: "confirmed", orderId: order.id };
}

/** Match a batch of settlements; one bad settlement never fails the batch. */
export async function matchSettlements(db: Db, settlements: SettlementInput[]): Promise<{
  results: SettlementMatchResult[];
  confirmed: number;
  unmatched: number;
}> {
  const results: SettlementMatchResult[] = [];
  for (const s of settlements ?? []) {
    try {
      results.push(await matchSettlement(db, s));
    } catch (e: any) {
      console.error("[recon-match] settlement failed:", e?.message);
      results.push({
        tenantId: s?.tenantId ?? "", amount: s?.amount ?? 0, reference: s?.reference,
        outcome: "error", detail: e?.message ?? String(e),
      });
    }
  }
  return {
    results,
    confirmed: results.filter(r => r.outcome === "confirmed").length,
    unmatched: results.filter(r => r.outcome === "unmatched").length,
  };
}
