// === W54 disputes ===
/**
 * disputeNotify.ts — shared dispute-notification helpers.
 *
 * DISP-1: buyer WA/TG notification on dispute resolution (channel parity via
 *         sendCustomerText — WA keeps the original waSender path, telegram
 *         routes through channelSender; fail-open, never blocks resolution).
 * DISP-8: admin-alert recipient resolution — settings.adminPhone first, then
 *         the tenant OWNER membership's users.phone before giving up.
 *
 * Nothing in this module throws into a business flow.
 */

import { and, eq, sql } from "drizzle-orm";
import { customers, orders, tenantMemberships, tenants, users } from "../../drizzle/schema";
import { t27 } from "./i18n";

type Db = any;

export interface BuyerContact {
  phone: string;
  locale: string;
}

/**
 * Resolve the buyer's reachable phone + locale for an order. Mirrors
 * sla.ts buyerPhoneForOrder (customers.id first, raw-phone customerId
 * fallback) and additionally returns the customer's catalog locale.
 */
export async function resolveBuyerContact(
  db: Db,
  tenantId: string,
  orderId: string | null,
): Promise<BuyerContact | null> {
  if (!orderId) return null;
  try {
    const [o] = await db
      .select({ customerId: orders.customerId })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!o) return null;
    // Telegram-native orders key customerId as `telegram:<chat_id>` — the
    // buyer is reachable on TG via the explicit channel ref (sendCustomerText
    // routes `telegram:` refs through channelSender).
    if (/^telegram:/i.test(String(o.customerId))) {
      const [ct] = await db
        .select({ language: customers.language })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, String(o.customerId))))
        .limit(1)
        .catch(() => [] as any[]);
      return { phone: String(o.customerId), locale: String(ct?.language ?? "en") };
    }
    const pick = (c: any): BuyerContact | null =>
      c?.whatsappPhone ? { phone: String(c.whatsappPhone), locale: String(c.language ?? "en") } : null;
    const [c] = await db
      .select({ whatsappPhone: customers.whatsappPhone, language: customers.language })
      .from(customers)
      .where(eq(customers.id, o.customerId))
      .limit(1)
      .catch(() => [] as any[]);
    const direct = pick(c);
    if (direct) return direct;
    // Chat-originated orders may store the buyer's PHONE DIGITS as
    // customerId rather than the customers.id UUID — digits match fallback.
    const digits = String(o.customerId ?? "").replace(/\D/g, "");
    if (digits.length >= 7) {
      const [c2] = await db
        .select({ whatsappPhone: customers.whatsappPhone, language: customers.language })
        .from(customers)
        .where(and(
          eq(customers.tenantId, tenantId),
          sql`regexp_replace(${customers.whatsappPhone}, '\\D', '', 'g') = ${digits}`,
        ))
        .limit(1)
        .catch(() => [] as any[]);
      const viaDigits = pick(c2);
      if (viaDigits) return viaDigits;
      // Raw phone with no customers row at all — still reachable.
      return { phone: digits, locale: "en" };
    }
    return null;
  } catch (e: any) {
    console.warn("[disputeNotify] buyer contact resolve failed:", e?.message);
    return null;
  }
}

export interface DisputeResolutionNotice {
  tenantId: string;
  orderId: string;
  orderNumber?: string | null;
  resolution: "full_release_to_merchant" | "full_refund_to_buyer" | "partial_refund" | "no_action" | "replacement";
  /** Pre-formatted amount label, e.g. "₦1,250.00" — refunds only. */
  amountLabel?: string | null;
  resolverNotes?: string | null;
  /** Replacement path: the RMA id/short-ref the buyer can quote. */
  rmaRef?: string | null;
}

/**
 * DISP-1: notify the buyer of the resolution outcome on their OWN channel
 * (WA + TG parity). Localized via MESSAGE_CATALOG (t27). Fail-open: a send
 * failure logs a warning and NEVER blocks or rolls back the resolution.
 */
export async function notifyBuyerDisputeResolution(
  db: Db,
  notice: DisputeResolutionNotice,
): Promise<{ attempted: boolean; channel?: string }> {
  try {
    const contact = await resolveBuyerContact(db, notice.tenantId, notice.orderId);
    if (!contact) {
      console.warn(`[disputeNotify] no buyer contact for order ${notice.orderId} — resolution notice skipped`);
      return { attempted: false };
    }
    const outcomeKey =
      notice.resolution === "full_refund_to_buyer" ? "disputeOutcomeFullRefund"
      : notice.resolution === "partial_refund" ? "disputeOutcomePartialRefund"
      : notice.resolution === "full_release_to_merchant" ? "disputeOutcomeRelease"
      : notice.resolution === "replacement" ? "disputeOutcomeReplacement"
      : "disputeOutcomeNoAction";
    const outcome = t27(contact.locale, outcomeKey, {
      amount: notice.amountLabel ?? "",
      rmaRef: notice.rmaRef ?? "",
    });
    let orderNumber = notice.orderNumber ?? null;
    if (!orderNumber) {
      const [o] = await db
        .select({ orderNumber: orders.orderNumber })
        .from(orders)
        .where(eq(orders.id, notice.orderId))
        .limit(1)
        .catch(() => [] as any[]);
      orderNumber = o?.orderNumber ?? notice.orderId;
    }
    const text = t27(contact.locale, "disputeResolvedBuyer", {
      orderNumber: orderNumber ?? notice.orderId,
      outcome,
      notes: notice.resolverNotes ? ` ${notice.resolverNotes}` : "",
    });
    const { sendCustomerText } = await import("./channelParity");
    const routed = await sendCustomerText(notice.tenantId, contact.phone, "dispute_resolution", text, {
      notifType: "dispute_resolved",
      orderId: notice.orderId,
    });
    return { attempted: true, channel: routed.channel };
  } catch (e: any) {
    console.warn("[disputeNotify] buyer resolution notice failed (fail-open):", e?.message);
    return { attempted: false };
  }
}

/** DISP-3: buyer notice that the merchant responded (under_review). */
export async function notifyBuyerMerchantResponded(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<void> {
  try {
    const contact = await resolveBuyerContact(db, tenantId, orderId);
    if (!contact) return;
    const [o] = await db
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
      .catch(() => [] as any[]);
    const text = t27(contact.locale, "disputeMerchantResponded", {
      orderNumber: o?.orderNumber ?? orderId,
    });
    const { sendCustomerText } = await import("./channelParity");
    await sendCustomerText(tenantId, contact.phone, "dispute_resolution", text, {
      notifType: "dispute_merchant_responded",
      orderId,
    });
  } catch (e: any) {
    console.warn("[disputeNotify] merchant-responded notice failed (fail-open):", e?.message);
  }
}

/**
 * DISP-8: resolve the tenant admin alert phone. Order:
 *   1. tenants.settings.adminPhone (or nested whatsapp/notifications adminPhone)
 *   2. the tenant OWNER membership's users.phone (oldest owner membership)
 *   3. null — caller records the alert in logs only.
 */
export async function resolveAdminAlertPhone(db: Db, tenantId: string): Promise<string | null> {
  try {
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .catch(() => [] as any[]);
    const s = (tenant?.settings ?? {}) as any;
    const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
    if (typeof cand === "string" && cand.trim()) return cand.trim();
  } catch (e: any) {
    console.warn("[disputeNotify] tenant settings lookup failed:", e?.message);
  }
  // Owner-membership fallback (DISP-8).
  try {
    const rows = await db
      .select({ phone: users.phone })
      .from(tenantMemberships)
      .innerJoin(users, sql`${users.id}::text = ${tenantMemberships.userId}`)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.role, "owner"),
        sql`${users.phone} IS NOT NULL AND ${users.phone} <> ''`,
      ))
      .orderBy(tenantMemberships.createdAt)
      .limit(1)
      .catch(() => [] as any[]);
    const phone = rows?.[0]?.phone;
    if (typeof phone === "string" && phone.trim()) return phone.trim();
  } catch (e: any) {
    console.warn("[disputeNotify] owner membership fallback failed:", e?.message);
  }
  return null;
}
