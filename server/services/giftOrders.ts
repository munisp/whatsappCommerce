// === W46 uc-ux (Coder E): UC-24 — gift orders ===
/**
 * giftOrders.ts — order-level gift options.
 *
 * Chat grammar (shared nlp engine → BOTH channels): at any checkout step
 * "this is a gift", "gift wrap it", "send to 23480…" sticks gift options to
 * the session context; createChatOrder (adjacent seam in routers/nlp.ts)
 * charges the tenant's giftWrapFeeCents as an explicit fee line and stamps
 * orders.isGift/giftMessage/giftRecipientPhone/giftWrapFeeCents.
 *
 * Receipts: `renderGiftReceipt` renders the recipient summary WITHOUT
 * prices; `giftReceiptSuppression` is the guard receipt-renderers consult
 * before showing amounts.
 */

import { eq, sql } from "drizzle-orm";
import { orders, tenants } from "../../drizzle/schema";
import { sendCustomerText } from "./channelParity";

type Db = any;

export interface GiftOptions {
  isGift: boolean;
  message?: string | null;
  recipientPhone?: string | null;
  wrap?: boolean;
}

/** Tenant-configured gift-wrap fee (integer cents; 0 = wrap free/off). */
export async function getGiftWrapFeeCents(db: Db, tenantId: string): Promise<number> {
  const [t] = await db.select({ fee: tenants.giftWrapFeeCents }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);
  return Number(t?.fee ?? 0);
}

/**
 * Apply gift options to a created order (post-hoc "actually, make it a
 * gift" before payment). The wrap fee line charged at checkout lives on
 * orders.giftWrapFeeCents — this stamps the same columns when options were
 * captured AFTER creation.
 */
export async function applyGiftOptions(
  db: Db,
  opts: { tenantId: string; orderId: string; gift: GiftOptions; wrapFeeCents?: number },
): Promise<{ applied: boolean; wrapFeeCents: number }> {
  if (!opts.gift.isGift && !opts.gift.wrap) return { applied: false, wrapFeeCents: 0 };
  const wrapFeeCents = opts.gift.wrap ? (opts.wrapFeeCents ?? await getGiftWrapFeeCents(db, opts.tenantId)) : 0;
  await db.update(orders).set({
    isGift: true,
    giftMessage: opts.gift.message ?? null,
    giftRecipientPhone: opts.gift.recipientPhone ?? null,
    giftWrapFeeCents: wrapFeeCents,
    updatedAt: new Date(),
  }).where(eq(orders.id, opts.orderId));
  return { applied: true, wrapFeeCents };
}

/** True when receipt renderers must hide prices for this order. */
export function giftReceiptSuppression(order: { isGift?: boolean | null }): boolean {
  return order.isGift === true;
}

/**
 * Gift receipt for the recipient: itemized lines WITHOUT prices, the gift
 * message, and no payment link/total. Prices stay on the buyer's own
 * (normal) receipt.
 */
export function renderGiftReceipt(opts: {
  orderNumber: string;
  buyerName?: string | null;
  message?: string | null;
  items: Array<{ productName: string; quantity: number }>;
}): string {
  const lines: string[] = [
    `🎁 *A gift is on its way to you!*`,
    opts.buyerName ? `From: ${opts.buyerName}` : null,
    `Order: ${opts.orderNumber}`,
    "",
    ...opts.items.map((i) => `• ${i.productName} × ${i.quantity}`),
  ].filter((l): l is string => typeof l === "string");
  if (opts.message) lines.push("", `💌 "${opts.message}"`);
  lines.push("", "No prices shown — enjoy your gift! 🎉");
  return lines.join("\n");
}

/** Notify the gift recipient on BOTH channels (gift_order parity category). */
export async function notifyGiftRecipient(
  db: Db,
  opts: { tenantId: string; orderId: string },
): Promise<{ sent: boolean }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, opts.orderId)).limit(1);
  if (!order?.isGift || !order.giftRecipientPhone) return { sent: false };
  const items = await db.execute(sql`
    SELECT "productName", quantity FROM order_items WHERE "orderId" = ${opts.orderId}`);
  const rows = ((items as any).rows ?? items) as any[];
  const body = renderGiftReceipt({
    orderNumber: order.orderNumber,
    message: order.giftMessage,
    items: rows.map((r) => ({ productName: r.productName, quantity: Number(r.quantity) })),
  });
  await sendCustomerText(opts.tenantId, order.giftRecipientPhone, "gift_order", body, { notifType: "gift_recipient" });
  return { sent: true };
}

/** Buyer-facing checkout annotation appended to the order summary. */
export function giftSummaryLine(gift: GiftOptions, wrapFeeCents: number, currency: string): string {
  const parts: string[] = [];
  if (gift.wrap && wrapFeeCents > 0) parts.push(`gift wrap (+${currency} ${(wrapFeeCents / 100).toFixed(2)})`);
  else if (gift.wrap) parts.push("gift wrap");
  if (gift.recipientPhone) parts.push(`shipping to ${gift.recipientPhone} as a gift`);
  else if (gift.isGift) parts.push("marked as a gift (recipient receipt hides prices)");
  return parts.length ? `\n🎁 Gift options: ${parts.join("; ")}.` : "";
}
// === END W46 uc-ux ===
