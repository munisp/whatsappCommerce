/**
 * Order CRUD — full lifecycle: create, update status, cancel, refund
 */
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { orders, orderItems, refunds, inventorySnapshots, paymentIntents, customers } from "../../drizzle/schema";
import { sendOrderNotificationWithLog, type OrderNotifType } from "./whatsappNotifications";
import { startOrderFulfillmentWorkflow } from "../temporal";
import {
  checkAvailability,
  reserveStock,
  releaseReservations,
  InsufficientStockError,
} from "../services/inventory";
import { syncLocalChange } from "../services/integrations/outbox";
import { validatePromo, applyPromo } from "../services/promos";
import { toMinorUnitsExact, minorUnitsToString } from "../../shared/escrowAmounts";

// ── F12: legal order status state machine ────────────────────────────────────
// Any-status→any-status updates let an order jump backwards (delivered→pending)
// or escape terminal states (cancelled→shipped), corrupting stock releases,
// notifications and downstream escrow/COD flows. Only these transitions are
// legal; "cancelled" and "refunded" are terminal, and an order may only be
// cancelled BEFORE it ships.
const ORDER_TRANSITIONS: Record<string, readonly string[]> = {
  pending:    ["confirmed", "cancelled"],
  confirmed:  ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped:    ["delivered"],
  delivered:  ["refunded"],
  cancelled:  [],
  refunded:   [],
};

export function isLegalOrderTransition(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

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
      // Optional promo/discount code — validated against the items subtotal;
      // the discount flows into totalAmount (integer minor-unit math, never
      // negative) and is recorded in orders.metadata.promo.
      promoCode: z.string().max(32).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Tenant isolation: orders may only be created for the caller's own tenant.
      assertTenantAccess(ctx.user, input.tenantId);

      const subtotal = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

      // ── Promo code (optional): validate BEFORE any order row exists. ─────
      // Integer minor-unit math (shared/escrowAmounts discipline): discount is
      // clamped so the total can never go negative. The usage claim
      // (usedCount++, atomic + maxUses-guarded) happens AFTER the order
      // transaction commits, so a rolled-back order never consumes a use.
      let promoMeta: { code: string; type: string; value: number; discount: string } | null = null;
      let total = subtotal;
      if (input.promoCode) {
        const validation = await validatePromo(db, input.tenantId, input.promoCode, subtotal);
        if (!validation.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Promo code ${input.promoCode} is not applicable (${validation.reason})`,
          });
        }
        const totalMinor = Math.max(0, toMinorUnitsExact(subtotal) - validation.discountMinor);
        total = Number(minorUnitsToString(totalMinor));
        promoMeta = {
          code: validation.promo.code,
          type: validation.promo.type,
          value: validation.promo.value,
          discount: validation.discount,
        };
      }

      const orderId = crypto.randomUUID();
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;

      // Pre-payment inventory guard: never create an order (that a payment
      // can later be taken against) for items that don't exist in stock.
      const availability = await checkAvailability(
        db,
        input.tenantId,
        input.items.map((i) => ({ productId: i.productId, qty: i.quantity })),
      );
      if (!availability.ok) {
        const s = availability.shortages[0];
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Insufficient stock for product: ${s.name} (requested ${s.requested}, available ${s.available})`,
        });
      }

      // Everything that must succeed-or-roll-back together runs in ONE
      // transaction: the legacy snapshot guard, the order rows, and the
      // atomic stock reservation (conditional UPDATE ... stockQuantity >=
      // qty — a concurrent checkout claiming the last unit rolls the whole
      // order back via InsufficientStockError).
      try {
        await db.transaction(async (tx) => {
          // Atomic oversell guard for each item, but ONLY for products under
          // ERP-synced inventory (inventory_snapshots is populated solely by
          // the Odoo/Medusa sync services — a missing row means this product's
          // stock lives entirely in products.stockQuantity, which reserveStock()
          // below already guards atomically and authoritatively).
          for (const item of input.items) {
            const [snapshot] = (await tx.execute(sql`
              SELECT "availableQty" FROM inventory_snapshots
              WHERE "tenantId" = ${input.tenantId} AND "productId" = ${item.productId}
              LIMIT 1
            `)) as unknown[];
            if (!snapshot) continue;
            const result = await tx.execute(sql`
              UPDATE inventory_snapshots
              SET "reservedQty" = CAST("reservedQty" AS NUMERIC) + ${item.quantity},
                  "availableQty" = CAST("availableQty" AS NUMERIC) - ${item.quantity}
              WHERE "tenantId" = ${input.tenantId} AND "productId" = ${item.productId}
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

          await tx.insert(orders).values({
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
            metadata: promoMeta ? { promo: promoMeta } : null,
            notes: input.notes,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Insert normalised order items
          for (const item of input.items) {
            await tx.insert(orderItems).values({
              id: crypto.randomUUID(),
              orderId,
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice.toFixed(2),
              currency: input.currency,
            });
          }

          // Atomic stock reservation on the products ledger (authoritative).
          await reserveStock(
            tx,
            input.tenantId,
            orderId,
            input.items.map((i) => ({ productId: i.productId, qty: i.quantity })),
          );
        });
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          const s = err.shortages[0];
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Insufficient stock for product: ${s.name} (requested ${s.requested}, available ${s.available})`,
          });
        }
        throw err;
      }

      // Claim the promo usage only AFTER the order transaction committed, so
      // rolled-back orders (insufficient stock etc.) never consume a use.
      // Claim-first + atomic: losing a maxUses race here just logs — the
      // order was validated pre-creation and keeps its discount.
      if (promoMeta) {
        applyPromo(db, input.tenantId, promoMeta.code).then((claimed) => {
          if (!claimed) {
            console.warn(`[orderCrud] promo ${promoMeta.code} usage claim lost maxUses race for order ${orderId}`);
          }
        }).catch((e: unknown) => console.error("[orderCrud] promo usage claim failed:", (e as Error)?.message));
      }

      // Start the Temporal order-fulfillment workflow. startWorkflow already
      // falls back to a DB-only record when Temporal is unavailable, so this
      // never blocks or fails order creation.
      const [customer] = await db.select({ whatsappPhone: customers.whatsappPhone })
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.tenantId, input.tenantId)))
        .limit(1);
      startOrderFulfillmentWorkflow({
        orderId,
        tenantId: input.tenantId,
        customerId: input.customerId,
        items: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity, price: i.unitPrice })),
        totalAmount: total,
        waPhoneNumber: customer?.whatsappPhone ?? "",
      }).catch((e: unknown) => console.warn("[orderCrud] OrderFulfillmentWorkflow start failed:", (e as Error)?.message));

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

      // Transactional outbox: enqueue Medusa/Odoo order sync + CRM customer
      // upsert. Rows are written BEFORE returning; delivery is async via the
      // outbox dispatcher, so a sync failure can never lose the event.
      try {
        await syncLocalChange(db, {
          tenantId: input.tenantId,
          entity: "order",
          entityId: orderId,
          action: "created",
          data: {
            orderNumber,
            customerId: input.customerId,
            currency: input.currency,
            totalAmount: total,
            items: input.items,
          },
        });
        await syncLocalChange(db, {
          tenantId: input.tenantId,
          entity: "customer",
          entityId: input.customerId,
          action: "updated",
          data: { customerId: input.customerId, whatsappPhone: customer?.whatsappPhone ?? null },
        });
      } catch (e: unknown) {
        console.error("[orderCrud] integration outbox enqueue failed:", (e as Error)?.message);
      }

      return { orderId, orderNumber, total, discount: promoMeta ? Number(promoMeta.discount) : 0, promo: promoMeta };
    }),

  /** Update order status */
  updateStatus: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"]),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      // Tenant isolation: only the owning tenant (or an admin) may mutate the order.
      assertTenantAccess(ctx.user, order.tenantId);
      if (input.status !== order.status && !isLegalOrderTransition(order.status, input.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Illegal status transition: ${order.status} → ${input.status}`,
        });
      }
      // Guarded update: re-check the current status in the WHERE clause so a
      // concurrent mutation between our read and this write can't smuggle an
      // illegal transition through.
      const transitioned = await db.update(orders).set({
        status: input.status,
        notes: input.notes,
        updatedAt: new Date(),
      }).where(and(eq(orders.id, input.orderId), eq(orders.status, order.status)))
        .returning({ id: orders.id });
      if (transitioned.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Order status changed concurrently — retry the transition",
        });
      }

      // Cancelling releases any still-reserved stock back to the pool
      // (claim-first, idempotent — safe even if the sweeper races us).
      if (input.status === "cancelled") {
        await releaseReservations(db, input.orderId)
          .catch((e: unknown) => console.error("[orderCrud] reservation release error:", (e as Error)?.message));
      }

      // Fire WhatsApp notification asynchronously (non-blocking — never fails the update)
      const notifTypeMap: Partial<Record<string, OrderNotifType>> = {
        confirmed:  "order_confirmation",
        shipped:    "order_shipped",
        delivered:  "order_delivered",
        cancelled:  "order_cancelled",
      };
      const notifType = notifTypeMap[input.status];
      if (notifType) {
        sendOrderNotificationWithLog(
          input.orderId,
          notifType,
          order.tenantId,
          ctx.user?.id ?? null,
        ).catch((e: unknown) => console.error("[orderCrud] WhatsApp notif error:", (e as Error)?.message));
      }

      return { ok: true };
    }),

  /** Cancel an order and release reserved inventory */
  cancel: protectedProcedure
    .input(z.object({ orderId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      // Tenant isolation.
      assertTenantAccess(ctx.user, order.tenantId);
      if (!isLegalOrderTransition(order.status, "cancelled")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Cannot cancel order in status: ${order.status}` });
      }

      // Cancel + restock + status flip in ONE transaction: a mid-flight
      // failure can no longer leave stock released for an order that is still
      // active (or vice versa). The status guard in the UPDATE makes a
      // concurrent cancel/fulfil a CONFLICT instead of a double restock.
      await db.transaction(async (tx) => {
        // Release reserved inventory
        const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));
        for (const item of items) {
          await tx.execute(sql`
            UPDATE inventory_snapshots
            SET "reservedQty" = GREATEST(0, CAST("reservedQty" AS NUMERIC) - ${item.quantity}),
                "availableQty" = CAST("availableQty" AS NUMERIC) + ${item.quantity}
            WHERE "productId" = ${item.productId}
          `);
        }

        const transitioned = await tx.update(orders).set({
          status: "cancelled",
          notes: input.reason ? `Cancelled: ${input.reason}` : "Cancelled",
          updatedAt: new Date(),
        }).where(and(eq(orders.id, input.orderId), eq(orders.status, order.status)))
          .returning({ id: orders.id });
        if (transitioned.length === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Order status changed concurrently — cancel aborted, no stock was released",
          });
        }
      });

      // Release pre-payment stock reservations (0031) — claim-first and
      // idempotent, so a concurrent expiry-sweeper run can't double-restock.
      await releaseReservations(db, input.orderId)
        .catch((e: unknown) => console.error("[orderCrud] reservation release error:", (e as Error)?.message));

      return { ok: true };
    }),

  /** Initiate a refund */
  refund: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      amount: z.number().min(0.01),
      reason: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      // Tenant isolation: refunds are money movement — only the owning tenant
      // (or an admin) may initiate one.
      assertTenantAccess(ctx.user, order.tenantId);
      if (order.paymentStatus !== "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Can only refund paid orders" });
      }

      // F13 — over-refund guard: the cumulative refund check and the refund
      // insert run in ONE transaction with the order row locked, so two
      // concurrent refunds can never each pass a stale total check and
      // together exceed the order total. Integer cents throughout.
      const orderTotalCents = Math.round(parseFloat(order.totalAmount) * 100);
      const requestCents = Math.round(input.amount * 100);

      const refundId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        // Lock the order row for the duration of the check + insert.
        await tx.execute(sql`SELECT id FROM orders WHERE id = ${input.orderId} FOR UPDATE`);
        const sumRows = await tx.execute(sql`
          SELECT COALESCE(SUM(amount::numeric), 0)::text AS total
          FROM refunds
          WHERE "orderId" = ${input.orderId} AND status IN ('pending', 'approved')
        `);
        const alreadyCents = Math.round(parseFloat(String((sumRows as unknown as { total: string }[])[0]?.total ?? "0")) * 100);
        if (alreadyCents + requestCents > orderTotalCents) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Refund of ${input.amount.toFixed(2)} would exceed the order total: already refunded ${(alreadyCents / 100).toFixed(2)} of ${(orderTotalCents / 100).toFixed(2)}`,
          });
        }

        await tx.insert(refunds).values({
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

        // Only a FULL cumulative refund flips the order to refunded (the
        // payment_status enum has no "partially_refunded" value and no schema
        // change is warranted) — partial refunds leave the order payable/whole
        // and are visible via the refunds table.
        if (alreadyCents + requestCents >= orderTotalCents) {
          await tx.update(orders).set({
            status: "refunded",
            paymentStatus: "refunded",
            updatedAt: new Date(),
          }).where(eq(orders.id, input.orderId));
        }
      });

      return { refundId, ok: true };
    }),

  /** Get order details with items */
  get: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      // Tenant isolation: order detail leaks customer + payment data.
      assertTenantAccess(ctx.user, order.tenantId);
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));
      const refundList = await db.select().from(refunds).where(eq(refunds.orderId, input.orderId));
      return { ...order, orderItems: items, refunds: refundList };
    }),

  /** List refunds for a tenant */
  listRefunds: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      assertTenantAccess(ctx.user, input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Tenant isolation: approving/rejecting a refund is money movement —
      // resolve the refund's tenant and enforce ownership.
      const [refund] = await db.select().from(refunds).where(eq(refunds.id, input.refundId)).limit(1);
      if (!refund) throw new TRPCError({ code: "NOT_FOUND", message: "Refund not found" });
      assertTenantAccess(ctx.user, refund.tenantId);
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
