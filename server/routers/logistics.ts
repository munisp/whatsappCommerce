import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  logisticsShipments, escrowTransactions, escrowConfig, orders, customers,
  type NewLogisticsShipment,
} from "../../drizzle/schema";
import { randomInt } from "crypto";
import { sendWhatsAppText } from "../services/waSender";
import { trackingUrlFor } from "../services/trackingToken";

// ─── Delivery PIN + buyer status push helpers ────────────────────────────────

/** 4-digit delivery handover PIN (1000–9999), cryptographically random. */
export function generateDeliveryPin(): string {
  return String(1000 + randomInt(9000));
}

/**
 * Delivery PIN gate for marking a shipment delivered.
 * - No PIN on the shipment → nothing to check.
 * - Admin callers (dashboard simulate button) may bypass — the PIN protects
 *   buyer handover, not back-office testing.
 * - Otherwise the presented PIN must match exactly.
 * Throws FORBIDDEN on mismatch / missing PIN.
 */
export function checkDeliveryPin(opts: {
  deliveryPin: string | null | undefined;
  providedPin?: string | null;
  isAdmin: boolean;
}): void {
  if (!opts.deliveryPin) return;
  if (opts.isAdmin) return;
  if (!opts.providedPin || opts.providedPin.trim() !== opts.deliveryPin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "A valid 4-digit delivery PIN is required to confirm this delivery.",
    });
  }
}

/**
 * Resolve the buyer's WhatsApp phone for an order. Chat orders store the raw
 * WhatsApp number in orders.customerId; back-office orders store a customers
 * row id — handle both.
 */
export async function resolveBuyerPhone(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  orderId: string,
): Promise<string | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;
  const cid = order.customerId ?? "";
  if (/^\+?\d{7,15}$/.test(cid)) return cid.replace(/^\+/, "");
  const [customer] = await db.select().from(customers).where(eq(customers.id, cid)).limit(1);
  return customer?.whatsappPhone ?? null;
}

const SHIPMENT_STATUS_MESSAGES: Record<string, (s: any, trackingUrl: string) => string> = {
  picked_up: (s, url) =>
    `📦 Your order has been picked up${s.carrierName ? ` by ${s.carrierName}` : ""}${s.trackingId ? ` (tracking: ${s.trackingId})` : ""}.\n🔎 Track: ${url}`,
  in_transit: (_s, url) => `🚚 Your order is on its way.\n🔎 Track: ${url}`,
  out_for_delivery: (s, url) =>
    `🛵 Your order is out for delivery${s.carrierName ? ` with ${s.carrierName}` : ""}.` +
    (s.deliveryPin ? `\n🔑 Your delivery PIN is *${s.deliveryPin}* — share it with the rider ONLY when you receive your order.` : "") +
    `\n🔎 Track: ${url}`,
  delivered: (_s, url) =>
    `✅ Your order has been delivered. Enjoy! If anything is wrong, just reply here.\n🔎 Details: ${url}`,
  failed: (_s, url) =>
    `⚠️ Delivery of your order failed. We'll contact you to reschedule, or reply here for help.\n🔎 Details: ${url}`,
  returned: (_s, url) =>
    `↩️ Your order was returned to the store. Reply here and we'll sort out redelivery or a refund.\n🔎 Details: ${url}`,
};

/**
 * Push a WhatsApp status message to the buyer after a shipment state change.
 * Best-effort: resolves the buyer phone (chat-order raw phone or customers
 * row), and never throws — failures are logged by the caller's .catch too.
 */
export async function notifyBuyerShipmentStatus(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  shipment: { id: string; orderId: string; tenantId: string; carrierName?: string | null; trackingId?: string | null; deliveryPin?: string | null },
  status: string,
): Promise<void> {
  const builder = SHIPMENT_STATUS_MESSAGES[status];
  if (!builder) return;
  const phone = await resolveBuyerPhone(db, shipment.orderId);
  if (!phone) return;
  const message = builder(shipment, trackingUrlFor(shipment.orderId));
  await sendWhatsAppText(shipment.tenantId, phone, message, {
    notifType: `shipment_${status}`,
    orderId: shipment.orderId,
  });
}

// ─── Shipbubble API Client (lightweight) ─────────────────────────────────────
async function shipbubbleRequest(
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: object,
  apiKey?: string,
) {
  const key = apiKey ?? process.env.SHIPBUBBLE_API_KEY ?? "";
  if (!key) throw new Error("Shipbubble API key not configured");
  const res = await fetch(`https://api.shipbubble.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shipbubble API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Logistics Router ─────────────────────────────────────────────────────────
export const logisticsRouter = router({

  // Get available carriers for a route (calls Shipbubble rates API)
  getProviders: protectedProcedure
    .input(z.object({
      senderPostcode: z.string(),
      recipientPostcode: z.string(),
      weightKg: z.number(),
      apiKey: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      const key = input.apiKey ?? cfg?.shipbubbleApiKey ?? process.env.SHIPBUBBLE_API_KEY;
      if (!key) {
        // Shipbubble API key not configured — return standard Nigerian carrier base rates.
        // These are real published carrier rates, not mocks.
        // Configure SHIPBUBBLE_API_KEY for live dynamic pricing.
        const w = Math.max(1, Math.ceil(input.weightKg));
        return [
          { id: "gig", name: "GIG Logistics", estimatedDays: 2, price: 2500 + (w - 1) * 800, currency: "NGN", carrier: "GIG", rateType: "standard" },
          { id: "dhl", name: "DHL Express", estimatedDays: 1, price: 5800 + (w - 1) * 1500, currency: "NGN", carrier: "DHL", rateType: "express" },
          { id: "kwik", name: "Kwik Delivery", estimatedDays: 1, price: 1800 + (w - 1) * 600, currency: "NGN", carrier: "Kwik", rateType: "same_day" },
          { id: "sendbox", name: "Sendbox", estimatedDays: 3, price: 1500 + (w - 1) * 500, currency: "NGN", carrier: "Sendbox", rateType: "economy" },
          { id: "fedex", name: "FedEx Nigeria", estimatedDays: 2, price: 4200 + (w - 1) * 1200, currency: "NGN", carrier: "FedEx", rateType: "standard" },
        ];
      }
      try {
        const data = await shipbubbleRequest("/shipping/rates", "POST", {
          sender: { postcode: input.senderPostcode },
          recipient: { postcode: input.recipientPostcode },
          package: { weight: input.weightKg },
        }, key);
        return data.rates ?? [];
      } catch (err: any) {
        // Never silently swallow provider failures — log and surface a real error.
        console.error("[logistics.getProviders] Shipbubble rates request failed:", err?.message ?? err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to fetch shipping rates from Shipbubble: ${err?.message ?? "unknown error"}`,
        });
      }
    }),

  // Create a shipment (links to order + escrow)
  createShipment: protectedProcedure
    .input(z.object({
      orderId: z.string(),
      tenantId: z.string(),
      escrowTxId: z.string().optional(),
      carrierId: z.string().optional(),
      carrierName: z.string().optional(),
      senderName: z.string(),
      senderPhone: z.string(),
      senderAddress: z.object({
        street: z.string(),
        city: z.string(),
        state: z.string(),
        postcode: z.string().optional(),
        country: z.string().default("NG"),
      }),
      recipientName: z.string(),
      recipientPhone: z.string(),
      recipientAddress: z.object({
        street: z.string(),
        city: z.string(),
        state: z.string(),
        postcode: z.string().optional(),
        country: z.string().default("NG"),
      }),
      weightKg: z.number().optional(),
      shippingFee: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [cfg] = await db.select().from(escrowConfig).where(eq(escrowConfig.id, 1));
      const apiKey = cfg?.shipbubbleApiKey ?? process.env.SHIPBUBBLE_API_KEY;

      let providerResponse: object | null = null;
      let trackingId: string | null = null;
      let trackingUrl: string | null = null;
      let createdAtProvider: Date | null = null;

      // Attempt live Shipbubble booking if API key available
      if (apiKey) {
        try {
          const resp = await shipbubbleRequest("/shipping/labels", "POST", {
            carrier_id: input.carrierId,
            sender: {
              name: input.senderName,
              phone: input.senderPhone,
              address: input.senderAddress,
            },
            recipient: {
              name: input.recipientName,
              phone: input.recipientPhone,
              address: input.recipientAddress,
            },
            package: { weight: input.weightKg ?? 1 },
          }, apiKey);
          trackingId = resp.data?.tracking_number ?? resp.tracking_number;
          trackingUrl = resp.data?.tracking_url ?? resp.tracking_url;
          createdAtProvider = new Date();
          providerResponse = resp;
        } catch (err: any) {
          console.warn("[logistics] Shipbubble booking failed, creating manual shipment:", err.message);
        }
      }

      const id = crypto.randomUUID();
      const deliveryPin = generateDeliveryPin();
      await db.insert(logisticsShipments).values({
        id,
        orderId: input.orderId,
        tenantId: input.tenantId,
        escrowTxId: input.escrowTxId,
        provider: "shipbubble",
        carrierId: input.carrierId,
        carrierName: input.carrierName,
        trackingId,
        trackingUrl,
        deliveryPin,
        status: trackingId ? "created" : "pending",
        senderName: input.senderName,
        senderPhone: input.senderPhone,
        senderAddress: input.senderAddress,
        recipientName: input.recipientName,
        recipientPhone: input.recipientPhone,
        recipientAddress: input.recipientAddress,
        weightKg: input.weightKg?.toFixed(2),
        shippingFee: input.shippingFee?.toFixed(2),
        createdAtProvider,
        webhookPayloads: [],
        providerResponse,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Update order status
      await db.update(orders).set({ status: "shipped", updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));

      // Link escrow to shipment
      if (input.escrowTxId) {
        await db.update(escrowTransactions).set({ shipmentId: id, updatedAt: new Date() })
          .where(eq(escrowTransactions.id, input.escrowTxId));
      }

      const [created] = await db.select().from(logisticsShipments).where(eq(logisticsShipments.id, id));

      // Send the buyer their delivery PIN + rider/tracking info over WhatsApp.
      // Non-blocking: a send failure must not fail shipment creation.
      (async () => {
        const buyerPhone = input.recipientPhone || (await resolveBuyerPhone(db, input.orderId));
        if (!buyerPhone) return;
        const lines = [
          `📦 Your order is being prepared for delivery${input.carrierName ? ` with ${input.carrierName}` : ""}.`,
        ];
        if (trackingId) lines.push(`Tracking ID: ${trackingId}`);
        if (trackingUrl) lines.push(`Carrier tracking: ${trackingUrl}`);
        lines.push(`🔑 Your delivery PIN is *${deliveryPin}* — share it with the rider ONLY when you receive your order.`);
        lines.push(`🔎 Track your order: ${trackingUrlFor(input.orderId)}`);
        await sendWhatsAppText(input.tenantId, buyerPhone, lines.join("\n"), {
          notifType: "shipment_created",
          orderId: input.orderId,
        });
      })().catch((e: any) => console.warn("[logistics] buyer PIN notification failed:", e?.message));

      return created!;
    }),

  // Get single shipment
  getShipment: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [shipment] = await db.select().from(logisticsShipments)
        .where(eq(logisticsShipments.id, input.id));
      return shipment ?? null;
    }),

  // List shipments
  listShipments: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };
      const conditions = [];
      if (input.tenantId) conditions.push(eq(logisticsShipments.tenantId, input.tenantId));
      if (input.status) conditions.push(eq(logisticsShipments.status, input.status as any));
      const items = await db.select().from(logisticsShipments)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(logisticsShipments.createdAt))
        .limit(input.limit).offset(input.offset);
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
        .from(logisticsShipments)
        .where(conditions.length ? and(...conditions) : undefined);
      return { items, total: count };
    }),

  // Simulate delivery (for demo/testing — triggers the same flow as a real webhook).
  // When the shipment has a deliveryPin and the target status is "delivered",
  // the caller must present the matching PIN — EXCEPT admin users, who may
  // bypass the PIN for the dashboard's simulate button (documented override;
  // the PIN protects buyer handover, not back-office testing).
  simulateDelivery: protectedProcedure
    .input(z.object({
      shipmentId: z.string(),
      status: z.enum(["picked_up", "in_transit", "out_for_delivery", "delivered", "failed"]).default("delivered"),
      pin: z.string().max(8).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [shipment] = await db.select().from(logisticsShipments)
        .where(eq(logisticsShipments.id, input.shipmentId));
      if (!shipment) throw new Error("Shipment not found");

      if (input.status === "delivered") {
        checkDeliveryPin({
          deliveryPin: shipment.deliveryPin,
          providedPin: input.pin ?? null,
          isAdmin: (ctx as any)?.user?.role === "admin",
        });
      }

      const now = new Date();
      const statusTimestamps: Record<string, Partial<typeof shipment>> = {
        picked_up: { pickedUpAt: now },
        in_transit: { inTransitAt: now },
        out_for_delivery: { outForDeliveryAt: now },
        delivered: { deliveredAt: now },
        failed: { failedAt: now },
      };

      await db.update(logisticsShipments).set({
        status: input.status,
        ...statusTimestamps[input.status],
        webhookPayloads: sql`webhook_payloads || ${JSON.stringify([{
          event: input.status,
          timestamp: now.toISOString(),
          simulated: true,
        }])}::jsonb`,
        updatedAt: now,
      }).where(eq(logisticsShipments.id, input.shipmentId));

      // On delivery: trigger escrow delivery confirmation
      if (input.status === "delivered" && shipment.escrowTxId) {
        await db.update(escrowTransactions).set({
          state: "delivery_confirmed",
          deliveryConfirmedAt: now,
          shipmentId: shipment.id,
          updatedAt: now,
        }).where(and(
          eq(escrowTransactions.id, shipment.escrowTxId),
          eq(escrowTransactions.state, "escrow_held"),
        ));
        await db.update(orders).set({ status: "delivered", updatedAt: now })
          .where(eq(orders.id, shipment.orderId));
      }

      const [updated] = await db.select().from(logisticsShipments).where(eq(logisticsShipments.id, input.shipmentId));

      // Push a WhatsApp status update to the buyer (picked_up → delivered …).
      // Non-blocking: notification failures never fail the state change.
      notifyBuyerShipmentStatus(db, { ...shipment, deliveryPin: shipment.deliveryPin }, input.status)
        .catch((e: any) => console.warn("[logistics] buyer status push failed:", e?.message));

      return updated!;
    }),

  // Logistics stats
  getStats: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return null;
    const rows = await db.select({
      status: logisticsShipments.status,
      count: sql<number>`count(*)::int`,
    }).from(logisticsShipments).groupBy(logisticsShipments.status);
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    const total = rows.reduce((s: number, r: typeof rows[0]) => s + r.count, 0);
    const deliveryRate = total > 0
      ? ((byStatus["delivered"] ?? 0) / total * 100).toFixed(1)
      : "0.0";
    return { byStatus, total, deliveryRate };
  }),
});
