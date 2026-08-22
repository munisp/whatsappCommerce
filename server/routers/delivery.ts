/**
 * server/routers/delivery.ts — W27 delivery aggregation router.
 *
 * Tenant-guarded procedures (protectedProcedure + tenantId + assertTenantAccess)
 * for merchant operations; internalProcedure for the status sweep; one
 * hardened publicProcedure (trackByToken) that follows the tracking.ts
 * bearer-token exemplar and exposes only a PII-scrubbed status view.
 */
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { internalProcedure, protectedProcedure, publicProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { courierConfigs, deliveries, orders } from "../../drizzle/schema";
import { verifyTrackingToken } from "../services/trackingToken";
import { getCourierAdapter, listCourierAdapters } from "../services/delivery/registry";
import {
  applyDeliveryStatus,
  bookDelivery,
  listDeliveries,
  quoteOrderDelivery,
  sweepDeliveryStatus,
  syncDeliveryStatus,
} from "../services/delivery/service";
import type { DeliveryState } from "../services/delivery/types";

export const deliveryRouter = router({
  /** Registered courier adapters (portal dropdown). */
  listAdapters: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return listCourierAdapters();
    }),

  /** Tenant's configured couriers. */
  listConfigs: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(courierConfigs)
        .where(eq(courierConfigs.tenantId, input.tenantId));
    }),

  /** Enable/configure a courier for the tenant. */
  configureCourier: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      courier: z.string().min(1).max(50),
      enabled: z.boolean().default(true),
      priority: z.number().int().min(0).max(1000).default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (!getCourierAdapter(input.courier)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown courier adapter: ${input.courier}` });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.insert(courierConfigs).values({
        tenantId: input.tenantId,
        courier: input.courier,
        enabled: input.enabled,
        priority: input.priority,
      }).onConflictDoUpdate({
        target: [courierConfigs.tenantId, courierConfigs.courier],
        set: { enabled: input.enabled, priority: input.priority, updatedAt: new Date() },
      });
      return { ok: true };
    }),

  /** Quote a delivery (checkout + portal quote tester). Fee in integer cents. */
  quote: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      dropoffAddress: z.string().max(500).optional(),
      dropoffLat: z.number().min(-90).max(90).optional(),
      dropoffLng: z.number().min(-180).max(180).optional(),
      weightKg: z.number().min(0).max(1000).optional(),
      orderValueCents: z.number().int().min(0).optional(),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return quoteOrderDelivery(db, input);
    }),

  /** Merchant books dispatch for an order (snapshots the checkout quote). */
  book: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string(),
      courier: z.string().max(50).optional(),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { delivery, booking } = await bookDelivery(db, input);
      return { delivery, booking };
    }),

  /** Advance a local-dispatch delivery (merchant's own rider updates). */
  advance: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      deliveryId: z.string(),
      status: z.enum(["picked_up", "in_transit", "delivered", "failed", "cancelled"]),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [row] = await db.select({ tenantId: deliveries.tenantId }).from(deliveries)
        .where(eq(deliveries.id, input.deliveryId)).limit(1);
      if (!row || row.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      }
      return applyDeliveryStatus(db, input.deliveryId, { status: input.status as DeliveryState });
    }),

  /** Pull latest status from the courier adapter. */
  sync: protectedProcedure
    .input(z.object({ tenantId: z.string(), deliveryId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [row] = await db.select({ tenantId: deliveries.tenantId }).from(deliveries)
        .where(eq(deliveries.id, input.deliveryId)).limit(1);
      if (!row || row.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      }
      return syncDeliveryStatus(db, input.deliveryId);
    }),

  /** Tenant delivery list (portal). */
  list: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return listDeliveries(db, input.tenantId, input.limit);
    }),

  /** Server-to-server sweep: sync all in-flight deliveries. */
  sweep: internalProcedure
    .input(z.object({ tenantId: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { scanned: 0, advanced: 0 };
      return sweepDeliveryStatus(db, input.tenantId);
    }),

  /**
   * Public buyer delivery tracking by HMAC token (tracking.ts exemplar).
   * Exposes ONLY: order number, delivery status + history, courier label,
   * ETA — no phone, address, or fee internals.
   */
  trackByToken: publicProcedure
    .input(z.object({ token: z.string().min(10).max(128) }))
    .query(async ({ input }) => {
      const orderId = verifyTrackingToken(input.token);
      if (!orderId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired tracking link" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [order] = await db.select({
        id: orders.id, orderNumber: orders.orderNumber, status: orders.status,
      }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      const [delivery] = await db.select().from(deliveries)
        .where(eq(deliveries.orderId, orderId))
        .orderBy(desc(deliveries.createdAt)).limit(1)
        .catch(() => []);
      return {
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        delivery: delivery
          ? {
              status: delivery.status,
              courierLabel: (delivery.quote as { label?: string } | null)?.label ?? delivery.courier,
              statusHistory: Array.isArray(delivery.statusHistory) ? delivery.statusHistory : [],
              etaMinutes: (delivery.quote as { etaMinutes?: number } | null)?.etaMinutes ?? null,
            }
          : null,
      };
    }),
});
