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
import { customers, orders, users, whatsappNotificationLog, whatsappCustomerReplies } from "../../drizzle/schema";
import { desc, and, ilike, gte, lte, or } from "drizzle-orm";
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
export interface SendOrderNotifResult {
  sent: boolean;
  simulated: boolean;
  wamid: string | null;
}

export async function sendOrderNotification(p: OrderNotifPayload): Promise<SendOrderNotifResult> {
  const token = process.env.WAC_WHATSAPP_TOKEN;
  const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;

  if (!token || !phoneId) {
    // Simulation mode — log for development
    console.info(
      `[whatsappNotif] SIMULATION: ${p.notifType} → ${p.phone.slice(-4).padStart(p.phone.length, "*")} | Order ${p.orderNumber} | ${p.totalAmount} ${p.currency}`
    );
    return { sent: false, simulated: true, wamid: null };
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
    return { sent: false, simulated: false, wamid: null };
  }

  const data = await res.json().catch(() => ({})) as any;
  const wamid: string | null = data?.messages?.[0]?.id ?? null;
  return { sent: true, simulated: false, wamid };
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
  /** Manually trigger an order notification (admin use / testing). */
  sendOrderNotif: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      notifType: z.enum(["order_confirmation", "order_shipped", "order_delivered", "order_cancelled"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      await sendOrderNotificationWithLog(
        input.orderId,
        input.notifType,
        order.tenantId,
        ctx.user?.id ?? null,
      );
      return { sent: true };
    }),

  /** Get notification log for a specific order (admin). */
  getOrderNotifStatus: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { order: null, logs: [] };
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      const logs = await db
        .select()
        .from(whatsappNotificationLog)
        .where(eq(whatsappNotificationLog.orderId, input.orderId))
        .orderBy(desc(whatsappNotificationLog.createdAt))
        .limit(20);
      return {
        order: { id: order.id, orderNumber: order.orderNumber, status: order.status, customerId: order.customerId },
        logs,
      };
    }),

  /** Get the current user's notification history (paginated). */
  getNotificationHistory: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
      search: z.string().optional(),
      status: z.string().optional(),
      dateFrom: z.string().optional(), // ISO date string
      dateTo: z.string().optional(),   // ISO date string
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { logs: [], total: 0 };
      const conditions = [eq(whatsappNotificationLog.userId, ctx.user.id)];
      if (input.search) {
        conditions.push(
          or(
            ilike(whatsappNotificationLog.notifType, `%${input.search}%`),
            ilike(whatsappNotificationLog.phone, `%${input.search}%`),
            ilike(whatsappNotificationLog.wamid ?? "", `%${input.search}%`)
          )!
        );
      }
      if (input.status) {
        conditions.push(eq(whatsappNotificationLog.status, input.status as any));
      }
      if (input.dateFrom) {
        conditions.push(gte(whatsappNotificationLog.createdAt, new Date(input.dateFrom)));
      }
      if (input.dateTo) {
        const toDate = new Date(input.dateTo);
        toDate.setHours(23, 59, 59, 999);
        conditions.push(lte(whatsappNotificationLog.createdAt, toDate));
      }
      const logs = await db
        .select()
        .from(whatsappNotificationLog)
        .where(and(...conditions))
        .orderBy(desc(whatsappNotificationLog.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return { logs };
    }),

  /** Admin: Resend a failed notification by log ID. Creates a new log row. */
  resendNotification: protectedProcedure
    .input(z.object({ logId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [original] = await db
        .select()
        .from(whatsappNotificationLog)
        .where(eq(whatsappNotificationLog.id, input.logId))
        .limit(1);
      if (!original) throw new TRPCError({ code: "NOT_FOUND", message: "Notification log not found" });
      if (original.status !== "failed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only failed notifications can be resent" });
      }
      // Resolve fresh order details
      let orderNumber = original.orderId ?? "";
      let customerName = "";
      let totalAmount = "0.00";
      let currency = "NGN";
      if (original.orderId) {
        const [ord] = await db.select().from(orders).where(eq(orders.id, original.orderId)).limit(1);
        if (ord) {
          orderNumber = ord.orderNumber;
          totalAmount = ord.totalAmount?.toString() ?? "0.00";
          currency = ord.currency ?? "NGN";
          if (ord.customerId) {
            const [cust] = await db.select().from(customers).where(eq(customers.id, ord.customerId)).limit(1);
            customerName = (cust as any)?.name ?? "";
          }
        }
      }
      // Create a new pending log row for the retry
      const newLogId = crypto.randomUUID();
      await db.insert(whatsappNotificationLog).values({
        id: newLogId,
        userId: original.userId,
        orderId: original.orderId,
        tenantId: original.tenantId,
        phone: original.phone,
        notifType: original.notifType,
        templateName: original.templateName,
        status: "pending",
      });
      try {
        const result = await sendOrderNotification({
          phone: original.phone,
          orderNumber,
          customerName,
          totalAmount,
          currency,
          status: original.notifType.replace("order_", ""),
          notifType: original.notifType as OrderNotifType,
        });
        const newStatus = result.simulated ? "simulated" : result.sent ? "sent" : "failed";
        await db.update(whatsappNotificationLog)
          .set({
            status: newStatus as any,
            wamid: result.wamid,
            sentAt: result.sent || result.simulated ? new Date() : undefined,
            failedAt: !result.sent && !result.simulated ? new Date() : undefined,
            failReason: !result.sent && !result.simulated ? "API returned non-OK status" : undefined,
            updatedAt: new Date(),
          })
          .where(eq(whatsappNotificationLog.id, newLogId));
        return { success: result.sent || result.simulated, newLogId, wamid: result.wamid };
      } catch (err: any) {
        await db.update(whatsappNotificationLog)
          .set({ status: "failed", failedAt: new Date(), failReason: err?.message ?? "Unknown error", updatedAt: new Date() })
          .where(eq(whatsappNotificationLog.id, newLogId));
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err?.message ?? "Send failed" });
      }
    }),

  /** Get customer replies for an order (admin only). */
  getCustomerReplies: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { replies: [] };
      const replies = await db
        .select()
        .from(whatsappCustomerReplies)
        .where(eq(whatsappCustomerReplies.orderId, input.orderId))
        .orderBy(desc(whatsappCustomerReplies.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return { replies };
    }),

  /** Mark a customer reply as read. */
  markReplyRead: protectedProcedure
    .input(z.object({ replyId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db
        .update(whatsappCustomerReplies)
        .set({ read: true, readAt: new Date() })
        .where(eq(whatsappCustomerReplies.id, input.replyId));
      return { success: true };
    }),

  /** Get unread reply count across all orders (for badge). */
  getUnreadReplyCount: protectedProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) return { count: 0 };
      const rows = await db
        .select({ id: whatsappCustomerReplies.id })
        .from(whatsappCustomerReplies)
        .where(eq(whatsappCustomerReplies.read, false));
      return { count: rows.length };
    }),
});

// ── Log-Persisting Wrapper ────────────────────────────────────────────────────
/**
 * Send an order notification AND persist a log row to whatsapp_notification_log.
 * Updates the log row with the wamid on success, or marks it failed on error.
 * This is the function called by orderCrud.updateStatus.
 */
export async function sendOrderNotificationWithLog(
  orderId: string,
  notifType: OrderNotifType,
  tenantId: string,
  userId?: number | null,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const { phone, customerName, orderNumber, totalAmount, currency } =
    await resolveOrderNotifRecipient(orderId, notifType);

  // Create a pending log row first
  const logId = crypto.randomUUID();
  const templateMap: Record<OrderNotifType, string> = {
    order_confirmation: process.env.WAC_TEMPLATE_ORDER_CONFIRM || "wac_order_confirmation",
    order_shipped:      process.env.WAC_TEMPLATE_ORDER_SHIPPED || "wac_order_shipped",
    order_delivered:    process.env.WAC_TEMPLATE_ORDER_DELIVERED || "wac_order_delivered",
    order_cancelled:    process.env.WAC_TEMPLATE_ORDER_CANCELLED || "wac_order_cancelled",
  };

  if (!phone) {
    // Log a failed attempt — no recipient found
    await db.insert(whatsappNotificationLog).values({
      id: logId,
      userId: userId ?? null,
      orderId,
      tenantId,
      phone: "unknown",
      notifType,
      templateName: templateMap[notifType],
      status: "failed",
      failedAt: new Date(),
      failReason: "No verified WhatsApp number found for this order's customer.",
    }).catch((e: any) => console.warn("[wa-notif-log] insert failed:", e?.message));
    return;
  }

  // Insert pending row
  await db.insert(whatsappNotificationLog).values({
    id: logId,
    userId: userId ?? null,
    orderId,
    tenantId,
    phone,
    notifType,
    templateName: templateMap[notifType],
    status: "pending",
  }).catch((e: any) => console.warn("[wa-notif-log] insert failed:", e?.message));

  try {
    const result = await sendOrderNotification({
      phone,
      orderNumber,
      customerName,
      totalAmount,
      currency,
      status: notifType.replace("order_", ""),
      notifType,
    
});

    if (result.simulated) {
      await db.update(whatsappNotificationLog)
        .set({ status: "simulated", sentAt: new Date(), updatedAt: new Date() })
        .where(eq(whatsappNotificationLog.id, logId))
        .catch((e: any) => console.warn("[wa-notif-log] update failed:", e?.message));
    } else if (result.sent) {
      await db.update(whatsappNotificationLog)
        .set({ status: "sent", wamid: result.wamid, sentAt: new Date(), updatedAt: new Date() })
        .where(eq(whatsappNotificationLog.id, logId))
        .catch((e: any) => console.warn("[wa-notif-log] update failed:", e?.message));
    } else {
      await db.update(whatsappNotificationLog)
        .set({ status: "failed", failedAt: new Date(), failReason: "API returned non-OK status", updatedAt: new Date() })
        .where(eq(whatsappNotificationLog.id, logId))
        .catch((e: any) => console.warn("[wa-notif-log] update failed:", e?.message));
    }
  } catch (err: any) {
    await db.update(whatsappNotificationLog)
      .set({ status: "failed", failedAt: new Date(), failReason: err?.message ?? "Unknown error", updatedAt: new Date() })
      .where(eq(whatsappNotificationLog.id, logId))
      .catch((e: any) => console.warn("[wa-notif-log] update failed:", e?.message));
  }
}
