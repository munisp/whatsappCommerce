import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { merchantNotifications, NewMerchantNotification } from "../../drizzle/schema";
import { eq, and, desc, lt, count, inArray } from "drizzle-orm";

// ─── Category → notification types mapping ───────────────────────────────────
const CATEGORY_TYPES: Record<string, string[]> = {
  payments: ["escrow_held", "escrow_settled", "escrow_refunded", "withdrawal_processed"],
  logistics: ["shipment_update", "delivery_confirmed"],
  disputes: ["dispute_opened", "dispute_resolved"],
};

// ─── Helper: emit a notification for a tenant ─────────────────────────────────
export async function emitNotification(payload: NewMerchantNotification): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.insert(merchantNotifications).values({
    ...payload,
    id: crypto.randomUUID(),
  });
}

// ─── Notification type → human-readable title/body templates ─────────────────
export const NOTIFICATION_TEMPLATES: Record<
  string,
  (meta: Record<string, unknown>) => { title: string; body: string }
> = {
  escrow_held: (m) => ({
    title: "Payment Held in Escrow",
    body: `Order #${m.orderNumber ?? m.orderId} — ₦${Number(m.amount ?? 0).toLocaleString()} is now held in escrow pending delivery confirmation.`,
  }),
  delivery_confirmed: (m) => ({
    title: "Delivery Confirmed",
    body: `Order #${m.orderNumber ?? m.orderId} has been marked as delivered. Escrow release is in progress.`,
  }),
  escrow_settled: (m) => ({
    title: "Funds Released to Your Wallet",
    body: `₦${Number(m.netAmount ?? m.amount ?? 0).toLocaleString()} from Order #${m.orderNumber ?? m.orderId} has been released to your merchant wallet.`,
  }),
  escrow_refunded: (m) => ({
    title: "Escrow Refunded to Buyer",
    body: `Order #${m.orderNumber ?? m.orderId} has been refunded. ₦${Number(m.amount ?? 0).toLocaleString()} returned to buyer.`,
  }),
  dispute_opened: (m) => ({
    title: "Dispute Opened on Your Order",
    body: `A dispute has been raised on Order #${m.orderNumber ?? m.orderId}. Reason: ${m.reason ?? "unspecified"}. Please submit your evidence within 48 hours.`,
  }),
  dispute_resolved: (m) => ({
    title: "Dispute Resolved",
    body: `The dispute on Order #${m.orderNumber ?? m.orderId} has been resolved. Resolution: ${m.resolution ?? "see details"}.`,
  }),
  withdrawal_processed: (m) => ({
    title: "Withdrawal Processed",
    body: `Your withdrawal of ₦${Number(m.amount ?? 0).toLocaleString()} has been processed and sent to your bank account.`,
  }),
  shipment_update: (m) => ({
    title: `Shipment ${String(m.status ?? "Update")}`,
    body: `Order #${m.orderNumber ?? m.orderId} — tracking: ${m.trackingId ?? "N/A"}. Status: ${m.status ?? "updated"}.`,
  }),
  system: (m) => ({
    title: String(m.title ?? "System Notification"),
    body: String(m.body ?? ""),
  }),
};

// ─── Router ───────────────────────────────────────────────────────────────────
export const notificationsRouter = router({
  /** List notifications for the current tenant (portal user) */
  list: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(), // ISO timestamp for pagination
      unreadOnly: z.boolean().default(false),
      category: z.enum(["all", "payments", "logistics", "disputes"]).default("all"),
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user.tenantId) throw new Error("No tenant associated with this account");
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const conditions = [eq(merchantNotifications.tenantId, ctx.user.tenantId)];
      if (input.unreadOnly) conditions.push(eq(merchantNotifications.read, false));
      if (input.cursor) conditions.push(lt(merchantNotifications.createdAt, new Date(input.cursor)));
      if (input.category !== "all") {
        const types = CATEGORY_TYPES[input.category] ?? [];
        if (types.length > 0) conditions.push(inArray(merchantNotifications.type, types as any[]));
      }

      const rows = await db
        .select()
        .from(merchantNotifications)
        .where(and(...conditions))
        .orderBy(desc(merchantNotifications.createdAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : undefined;

      return { items, nextCursor, hasMore };
    }),

  /** Get unread count for badge display */
  getUnreadCount: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user.tenantId) return { count: 0 };
      const db = await getDb();
      if (!db) return { count: 0 };
      const [row] = await db
        .select({ count: count() })
        .from(merchantNotifications)
        .where(and(
          eq(merchantNotifications.tenantId, ctx.user.tenantId),
          eq(merchantNotifications.read, false),
        ));
      return { count: Number(row?.count ?? 0) };
    }),

  /** Mark a single notification as read */
  markRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.tenantId) throw new Error("No tenant associated with this account");
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db
        .update(merchantNotifications)
        .set({ read: true, readAt: new Date() })
        .where(and(
          eq(merchantNotifications.id, input.id),
          eq(merchantNotifications.tenantId, ctx.user.tenantId),
        ));
      return { success: true };
    }),

  /** Mark all notifications as read */
  markAllRead: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (!ctx.user.tenantId) throw new Error("No tenant associated with this account");
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db
        .update(merchantNotifications)
        .set({ read: true, readAt: new Date() })
        .where(and(
          eq(merchantNotifications.tenantId, ctx.user.tenantId),
          eq(merchantNotifications.read, false),
        ));
      return { success: true };
    }),

  /** Admin: list notifications for any tenant */
  adminList: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") throw new Error("Forbidden");
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      return db
        .select()
        .from(merchantNotifications)
        .where(eq(merchantNotifications.tenantId, input.tenantId))
        .orderBy(desc(merchantNotifications.createdAt))
        .limit(input.limit);
    }),
});
