/**
 * Order CRUD — full lifecycle: create, update status, cancel, refund
 */
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { orders, orderItems, refunds, inventorySnapshots, paymentIntents } from "../../drizzle/schema";
import { sendOrderNotification, resolveOrderNotifRecipient, type OrderNotifType } from "./whatsappNotifications";

export const orderCrudRouter = router({
  /** Create a new order (admin/operator) */
  create: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerId: z.string(),
      conversationId: z.string().optional(),
      currency: z.string().default("NGN"),
      shippingAddress: z.record(z.string(), z.unknown()).optional(),
      notes: z.string().optional(),
      items: z.array(z.object({
        productId: z.string(),
        productName: z.string(),
        quantity: z.number().int().min(1),
        unitPrice: z.number().min(0),
      })),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const total = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
      const orderId = crypto.randomUUID();
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;

      // Atomic oversell guard for each item
      for (const item of input.items) {
        const result = await db.execute(sql`
          UPDATE inventory_snapshots
          SET "reservedQty" = CAST("reservedQty" AS NUMERIC) + ${item.quantity},
              "availableQty" = CAST("availableQty" AS NUMERIC) - ${item.quantity}
          WHERE "productId" = ${item.productId}
            AND CAST("availableQty" AS NUMERIC) >= ${item.quantity}
          RETURNING id
        `);
        if ((result as unknown[]).length === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Insufficient stock for product: ${item.productName}`,
          });
        }
      }

      await db.insert(orders).values({
        id: orderId,
        tenantId: input.tenantId,
        customerId: input.customerId,
        conversationId: input.conversationId,
        orderNumber,
        status: "pending",
        totalAmount: total.toFixed(2),
        currency: input.currency,
        paymentStatus: "unpaid",
        shippingAddress: input.shippingAddress ?? null,
        items: input.items,
        notes: input.notes,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Insert normalised order items
      for (const item of input.items) {
        await db.insert(orderItems).values({
          id: crypto.randomUUID(),
          orderId,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toFixed(2),
          currency: input.currency,
        });
      }

      return { orderId, orderNumber, total };
      // Publish order.created event to Kafka and Dapr (fire-and-forget)
      const orderEvent = {
        eventType: "order.created",
        orderId,
        orderNumber,
        tenantId: input.tenantId,
        customerId: input.customerId,
        total,
        currency: input.currency,
        timestamp: Date.now(),
      };
      publishOrderEvent(orderId, input.tenantId, "created", { orderNumber, total, currency: input.currency }).catch(() => {});
      daprPublish("wacommerce-pubsub", "wacommerce.orders.created", orderEvent).catch(() => {});
    }),

  /** Update order status */
  updateStatus: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"]),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.update(orders).set({
        status: input.status,
        notes: input.notes,
        updatedAt: new Date(),
      }).where(eq(orders.id, input.orderId));

      // Fire WhatsApp notification asynchronously (non-blocking — never fails the update)
      const notifTypeMap: Partial<Record<string, OrderNotifType>> = {
        confirmed:  "order_confirmation",
        shipped:    "order_shipped",
        delivered:  "order_delivered",
        cancelled:  "order_cancelled",
      };
      const notifType = notifTypeMap[input.status];
      if (notifType) {
        resolveOrderNotifRecipient(input.orderId, notifType)
          .then(({ phone, customerName, orderNumber, totalAmount, currency }) => {
            if (phone) {
              return sendOrderNotification({ phone, orderNumber, customerName, totalAmount, currency, status: input.status, notifType: notifType! });
            }
          })
          .catch((err) => console.error("[orderCrud] WhatsApp notif error:", err));
      }

      return { ok: true };
    }),

  /** Cancel an order and release reserved inventory */
  cancel: protectedProcedure
    .input(z.object({ orderId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      if (["delivered", "cancelled", "refunded"].includes(order.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Cannot cancel order in status: ${order.status}` });
      }

      // Release reserved inventory
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));
      for (const item of items) {
        await db.execute(sql`
          UPDATE inventory_snapshots
          SET "reservedQty" = GREATEST(0, CAST("reservedQty" AS NUMERIC) - ${item.quantity}),
              "availableQty" = CAST("availableQty" AS NUMERIC) + ${item.quantity}
          WHERE "productId" = ${item.productId}
        `);
      }

      await db.update(orders).set({
        status: "cancelled",
        notes: input.reason ? `Cancelled: ${input.reason}` : "Cancelled",
        updatedAt: new Date(),
      }).where(eq(orders.id, input.orderId));

      return { ok: true };
    }),

  /** Initiate a refund */
  refund: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      amount: z.number().min(0.01),
      reason: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      if (order.paymentStatus !== "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Can only refund paid orders" });
      }

      const refundId = crypto.randomUUID();
      await db.insert(refunds).values({
        id: refundId,
        orderId: input.orderId,
        tenantId: order.tenantId,
        amount: input.amount.toFixed(2),
        currency: order.currency,
        reason: input.reason,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.update(orders).set({
        status: "refunded",
        paymentStatus: "refunded",
        updatedAt: new Date(),
      }).where(eq(orders.id, input.orderId));

      return { refundId, ok: true };
    }),

  /** Get order details with items */
  get: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));
      const refundList = await db.select().from(refunds).where(eq(refunds.orderId, input.orderId));
      return { ...order, orderItems: items, refunds: refundList };
    }),

  /** List refunds for a tenant */
  listRefunds: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return db.select().from(refunds)
        .where(eq(refunds.tenantId, input.tenantId))
        .orderBy(sql`${refunds.createdAt} DESC`)
        .limit(input.limit);
    }),

  /** Approve/reject a refund */
  processRefund: protectedProcedure
    .input(z.object({
      refundId: z.string(),
      action: z.enum(["approved", "rejected"]),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.update(refunds).set({
        status: input.action,
        processedAt: input.action === "approved" ? new Date() : null,
        updatedAt: new Date(),
      }).where(eq(refunds.id, input.refundId));
      return { ok: true };
    }),
});
import { publishOrderEvent } from "../kafka";
import { daprPublish } from "../dapr";
