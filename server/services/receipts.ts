/**
 * Digital receipts — buyer-facing WhatsApp receipt sent on payment-confirm
 * success. Additive: invoked from paymentConfirm AFTER the reservation commit,
 * wrapped by the caller in try/catch so a receipt failure can never affect the
 * money path.
 *
 * Money figures come straight from the confirmed order row (items jsonb +
 * metadata.subtotal/deliveryFee/promo.discount + totalAmount) — never
 * recomputed loosely.
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db";
import { customers, logisticsShipments, orders, tenants } from "../../drizzle/schema";
import { sendWhatsAppText } from "./waSender";
import { trackingUrlFor } from "./trackingToken";
import { fmtMoney } from "../routers/nlp";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface ReceiptOrderItem {
  name: string;
  qty: number;
  unitPrice: number;
}

export interface ReceiptData {
  businessName: string;
  orderNumber: string;
  items: ReceiptOrderItem[];
  /** MAJOR units, from orders.metadata.subtotal. */
  subtotal: number | null;
  /** MAJOR units, from orders.metadata.deliveryFee. */
  deliveryFee: number | null;
  /** Applied promo from orders.metadata.promo (discount in MAJOR units). */
  promo: { code: string; discount: number } | null;
  /** MAJOR units, from orders.totalAmount — the amount actually paid. */
  total: number;
  currency: string;
  paymentRef: string;
  deliveryPin: string | null;
  trackingUrl: string;
}

/** Format the receipt message body (pure — exported for tests). */
export function buildReceiptMessage(r: ReceiptData): string {
  const lines: string[] = [
    `🧾 *${r.businessName} — Payment Receipt*`,
    `Order: ${r.orderNumber}`,
    "",
    ...r.items.map((i) => `${i.qty} × ${i.name} — ${fmtMoney(i.unitPrice * i.qty, r.currency)}`),
    "",
  ];
  if (r.subtotal != null) lines.push(`Subtotal: ${fmtMoney(r.subtotal, r.currency)}`);
  if (r.promo && r.promo.discount > 0) {
    lines.push(`🏷️ Discount (${r.promo.code}): −${fmtMoney(r.promo.discount, r.currency)}`);
  }
  if (r.deliveryFee != null && r.deliveryFee > 0) {
    lines.push(`Delivery fee: ${fmtMoney(r.deliveryFee, r.currency)}`);
  }
  lines.push(`*Total paid: ${fmtMoney(r.total, r.currency)}*`);
  lines.push(`Payment ref: ${r.paymentRef}`);
  if (r.deliveryPin) {
    lines.push("", `🔐 Your delivery PIN: *${r.deliveryPin}* — only share it with the rider at handover.`);
  }
  lines.push("", `🔎 Track your order: ${r.trackingUrl}`);
  return lines.join("\n");
}

/** Parse the order's items jsonb into receipt lines (handles both the
 * chat-flow {name, qty, price} and orderCrud {productName, quantity,
 * unitPrice} shapes). */
export function parseReceiptItems(raw: unknown): ReceiptOrderItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ReceiptOrderItem[] = [];
  for (const it of raw) {
    const o = it as Record<string, unknown>;
    const name = String(o.productName ?? o.name ?? "Item");
    const qty = Number(o.quantity ?? o.qty ?? 1);
    const unitPrice = Number(o.unitPrice ?? o.price ?? 0);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice)) continue;
    out.push({ name, qty, unitPrice });
  }
  return out;
}

function metadataNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build + send the receipt for a confirmed order. Resolves the buyer phone
 * (customers row, or the chat-flow convention of customerId == WhatsApp
 * phone), the tenant branding name, and the delivery PIN when a shipment
 * exists. Throws on unexpected errors — the caller must catch+log.
 */
export async function sendOrderReceipt(
  db: DbHandle,
  orderId: string,
  paymentRef: string,
): Promise<{ sent: boolean; reason?: string }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return { sent: false, reason: "order-not-found" };

  // Buyer phone: prefer the customers row; the WhatsApp chat flow stores the
  // phone directly as customerId.
  let buyerPhone = "";
  const [customer] = await db
    .select({ whatsappPhone: customers.whatsappPhone })
    .from(customers)
    .where(and(eq(customers.id, order.customerId), eq(customers.tenantId, order.tenantId)))
    .limit(1);
  if (customer?.whatsappPhone) {
    buyerPhone = customer.whatsappPhone;
  } else if (/^\+?[\d\s-]{5,}$/.test(order.customerId)) {
    buyerPhone = order.customerId;
  }
  if (!buyerPhone) return { sent: false, reason: "no-buyer-phone" };

  const [tenant] = await db
    .select({ settings: tenants.settings, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, order.tenantId))
    .limit(1);
  const branding = ((tenant?.settings as Record<string, unknown> | null)?.branding ?? {}) as Record<string, unknown>;
  const businessName =
    typeof branding.name === "string" && branding.name ? branding.name : (tenant?.name ?? "Store");

  // Delivery PIN when a shipment exists for this order.
  const [shipment] = await db
    .select({ deliveryPin: logisticsShipments.deliveryPin })
    .from(logisticsShipments)
    .where(eq(logisticsShipments.orderId, orderId))
    .limit(1);

  const meta = (order.metadata ?? null) as Record<string, unknown> | null;
  const promoMeta = (meta?.promo ?? null) as Record<string, unknown> | null;
  const promoDiscount = promoMeta ? Number(promoMeta.discount ?? 0) : 0;

  const message = buildReceiptMessage({
    businessName,
    orderNumber: order.orderNumber,
    items: parseReceiptItems(order.items),
    subtotal: metadataNumber(meta, "subtotal"),
    deliveryFee: metadataNumber(meta, "deliveryFee"),
    promo:
      promoMeta && typeof promoMeta.code === "string" && Number.isFinite(promoDiscount) && promoDiscount > 0
        ? { code: promoMeta.code, discount: promoDiscount }
        : null,
    total: Number(order.totalAmount),
    currency: order.currency,
    paymentRef,
    deliveryPin: shipment?.deliveryPin ?? null,
    trackingUrl: trackingUrlFor(order.id),
  });

  await sendWhatsAppText(order.tenantId, buyerPhone, message, {
    notifType: "payment_receipt",
    orderId: order.id,
  });
  return { sent: true };
}
