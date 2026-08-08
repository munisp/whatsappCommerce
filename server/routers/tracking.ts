/**
 * Public buyer order tracking.
 *
 * The order confirmation and every shipment status message include a
 * /track/<token> link. The token is `<orderId>.<HMAC>` (see
 * services/trackingToken.ts) — a bearer capability that exposes ONLY a
 * minimal, PII-scrubbed status view: no full name (first name only), no
 * phone, no address.
 */

import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { customers, logisticsShipments, orders } from "../../drizzle/schema";
import { verifyTrackingToken } from "../services/trackingToken";

export const trackingRouter = router({
  /** Public order tracking by HMAC token (shared with the buyer via WhatsApp). */
  getByToken: publicProcedure
    .input(z.object({ token: z.string().min(10).max(128) }))
    .query(async ({ input }) => {
      const orderId = verifyTrackingToken(input.token);
      if (!orderId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired tracking link" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

      // First name only — never expose full PII on a public link.
      let customerFirstName: string | null = null;
      const cid = order.customerId ?? "";
      if (!/^\+?\d{7,15}$/.test(cid)) {
        const [customer] = await db.select().from(customers).where(eq(customers.id, cid)).limit(1).catch(() => []);
        customerFirstName = customer?.name?.trim().split(/\s+/)[0] ?? null;
      }

      const orderItems = Array.isArray(order.items) ? (order.items as any[]) : [];
      const metadata = (order.metadata as Record<string, unknown> | null) ?? null;

      // Shipment status history (latest shipment for the order).
      const [shipment] = await db.select().from(logisticsShipments)
        .where(eq(logisticsShipments.orderId, order.id))
        .orderBy(desc(logisticsShipments.createdAt))
        .limit(1)
        .catch(() => []);

      // ETA engine: remaining minutes for the public tracking view (PII-safe).
      let etaMinutes: number | null = null;
      if (shipment) {
        try {
          const { estimateShipmentRemainingEta } = await import("../services/eta");
          etaMinutes = await estimateShipmentRemainingEta(db, {
            shipmentId: shipment.id, status: shipment.status, tenantId: order.tenantId,
          });
        } catch {
          etaMinutes = null;
        }
      }

      const shipmentHistory: Array<{ status: string; at: string | null }> = [];
      if (shipment) {
        const tsFields: Array<[string, Date | null]> = [
          ["created", shipment.createdAt],
          ["picked_up", shipment.pickedUpAt],
          ["in_transit", shipment.inTransitAt],
          ["out_for_delivery", shipment.outForDeliveryAt],
          ["delivered", shipment.deliveredAt],
          ["failed", shipment.failedAt],
          ["returned", shipment.returnedAt],
        ];
        for (const [status, at] of tsFields) {
          if (at) shipmentHistory.push({ status, at: at.toISOString() });
        }
      }

      return {
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        customerFirstName,
        items: orderItems.map((i: any) => ({
          name: i?.name ?? "Item",
          qty: Number(i?.qty ?? 1),
          price: String(i?.price ?? ""),
        })),
        subtotal: metadata?.subtotal ?? null,
        deliveryFee: metadata?.deliveryFee ?? null,
        fulfillment: metadata?.fulfillment ?? null,
        totalAmount: order.totalAmount,
        currency: order.currency,
        createdAt: order.createdAt,
        shipment: shipment
          ? {
              status: shipment.status,
              carrierName: shipment.carrierName,
              trackingId: shipment.trackingId,
              etaMinutes,
              history: shipmentHistory,
            }
          : null,
      };
    }),
});
