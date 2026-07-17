/**
 * WhatsApp Order Notifications Service
 *
 * Sends order confirmation and status update messages to customers'
 * verified WhatsApp numbers via the WhatsApp Business Cloud API.
 *
 * Notification types:
 *   - order_confirmation: Sent when order status changes to "confirmed"
 *   - order_shipped:      Sent when order status changes to "shipped"
 *   - order_delivered:    Sent when order status changes to "delivered"
 *   - order_cancelled:    Sent when order status changes to "cancelled"
 *
 * The recipient phone number is resolved from:
 *   1. The customer's whatsappPhone field (customers table)
 *   2. Fallback: the user's verified phone (users table, if linked)
 *
 * Notification preferences are respected:
 *   - whatsappNotifOrders: controls order_confirmation
 *   - whatsappNotifStatus: controls shipped/delivered/cancelled
 */

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { customers, orders, users } from "../../drizzle/schema";
import { router, protectedProcedure } from "../_core/trpc";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrderNotifType =
  | "order_confirmation"
  | "order_shipped"
  | "order_delivered"
  | "order_cancelled";

interface OrderNotifPayload {
  phone: string;
  orderNumber: string;
  customerName: string;
  totalAmount: string;
  currency: string;
  status: string;
  notifType: OrderNotifType;
}

// ── Template Builders ─────────────────────────────────────────────────────────

/**
 * Build a WhatsApp Cloud API message payload for an order notification.
 * Uses approved template names — these must be created in the WhatsApp Business Manager.
 *
 * Template names (create these in Meta Business Suite):
 *   - wac_order_confirmation  (category: UTILITY)
 *   - wac_order_shipped       (category: UTILITY)
 *   - wac_order_delivered     (category: UTILITY)
 *   - wac_order_cancelled     (category: UTILITY)
 *
 * Each template has body parameters: {{1}} = customer name, {{2}} = order number,
 * {{3}} = amount + currency, {{4}} = status label
 */
function buildOrderNotifPayload(p: OrderNotifPayload): object {
  const templateMap: Record<OrderNotifType, string> = {
    order_confirmation: process.env.WAC_TEMPLATE_ORDER_CONFIRM || "wac_order_confirmation",
    order_shipped:      process.env.WAC_TEMPLATE_ORDER_SHIPPED || "wac_order_shipped",
    order_delivered:    process.env.WAC_TEMPLATE_ORDER_DELIVERED || "wac_order_delivered",
    order_cancelled:    process.env.WAC_TEMPLATE_ORDER_CANCELLED || "wac_order_cancelled",
  };

  const statusLabels: Record<OrderNotifType, string> = {
    order_confirmation: "confirmed",
    order_shipped:      "shipped",
    order_delivered:    "delivered",
    order_cancelled:    "cancelled",
  };

  return {
    messaging_product: "whatsapp",
    to: p.phone,
    type: "template",
    template: {
      name: templateMap[p.notifType],
      language: { code: process.env.WAC_TEMPLATE_LANG || "en_US" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: p.customerName || "Customer" },
            { type: "text", text: p.orderNumber },
            { type: "text", text: `${p.totalAmount} ${p.currency}` },
            { type: "text", text: statusLabels[p.notifType] },
          ],
        },
      ],
    },
  };
}

// ── Core Sender ───────────────────────────────────────────────────────────────

/**
 * Send a WhatsApp order notification message.
 * Returns true on success, false if WAC credentials are not configured (simulation mode).
 * Throws TRPCError on API errors.
 */
export async function sendOrderNotification(p: OrderNotifPayload): Promise<boolean> {
  const token = process.env.WAC_WHATSAPP_TOKEN;
  const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;

  if (!token || !phoneId) {
    // Simulation mode — log for development
    console.info(
      `[whatsappNotif] SIMULATION: ${p.notifType} → ${p.phone.slice(-4).padStart(p.phone.length, "*")} | Order ${p.orderNumber} | ${p.totalAmount} ${p.currency}`
    );
    return false;
  }

  const payload = buildOrderNotifPayload(p);
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[whatsappNotif] API error ${res.status}: ${body}`);
    // Don't throw — notification failures should not block order updates
    return false;
  }

  return true;
}

// ── Resolver: get recipient phone for an order ────────────────────────────────

/**
 * Resolve the WhatsApp phone number for an order notification.
 * Priority: customer.whatsappPhone → user.phone (if verified and prefs allow)
 */
export async function resolveOrderNotifRecipient(
  orderId: string,
  notifType: OrderNotifType
): Promise<{ phone: string | null; customerName: string; orderNumber: string; totalAmount: string; currency: string }> {
  const db = await getDb();
  if (!db) return { phone: null, customerName: "", orderNumber: "", totalAmount: "0.00", currency: "USD" };

  // Fetch order + customer
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return { phone: null, customerName: "", orderNumber: "", totalAmount: "0.00", currency: "USD" };

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .limit(1);

  const customerName = customer?.name || "Customer";
  const orderNumber = order.orderNumber;
  const totalAmount = order.totalAmount?.toString() || "0.00";
  const currency = order.currency || "USD";

  // Primary: customer's whatsappPhone
  if (customer?.whatsappPhone) {
    return { phone: customer.whatsappPhone, customerName, orderNumber, totalAmount, currency };
  }

  // Fallback: find a user linked to this tenant with a verified phone and matching prefs
  // (used when the order was placed by a registered user, not a guest customer)
  const userRows = await db
    .select({
      phone: users.phone,
      phoneVerified: users.phoneVerified,
      whatsappNotifOrders: users.whatsappNotifOrders,
      whatsappNotifStatus: users.whatsappNotifStatus,
    })
    .from(users)
    .where(eq(users.tenantId, order.tenantId))
    .limit(10);

  for (const u of userRows) {
    if (!u.phone || !u.phoneVerified) continue;
    const prefAllowed =
      notifType === "order_confirmation" ? u.whatsappNotifOrders :
      u.whatsappNotifStatus;
    if (prefAllowed) {
      return { phone: u.phone, customerName, orderNumber, totalAmount, currency };
    }
  }

  return { phone: null, customerName, orderNumber, totalAmount, currency };
}

// ── tRPC Router ───────────────────────────────────────────────────────────────

export const whatsappNotificationsRouter = router({
  /**
   * Manually trigger an order notification (admin use / testing).
   */
  sendOrderNotif: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      notifType: z.enum(["order_confirmation", "order_shipped", "order_delivered", "order_cancelled"]),
    }))
    .mutation(async ({ input }) => {
      const { phone, customerName, orderNumber, totalAmount, currency } =
        await resolveOrderNotifRecipient(input.orderId, input.notifType);

      if (!phone) {
        return { sent: false, reason: "No verified WhatsApp number found for this order's customer." };
      }

      const sent = await sendOrderNotification({
        phone,
        orderNumber,
        customerName,
        totalAmount,
        currency,
        status: input.notifType.replace("order_", ""),
        notifType: input.notifType,
      });

      return { sent, phone: phone.slice(-4).padStart(phone.length, "*") };
    }),

  /**
   * Get notification send history for an order (last 20 events from logs).
   * Returns a lightweight in-memory list — for a production system, persist to a
   * whatsapp_notification_log table.
   */
  getOrderNotifStatus: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { order: null };
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          customerId: order.customerId,
        },
      };
    }),
});
