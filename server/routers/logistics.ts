import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  logisticsShipments, escrowTransactions, escrowConfig, orders,
  type NewLogisticsShipment,
} from "../../drizzle/schema";

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
        // Return mock providers when API key not configured
        return [
          { id: "gig", name: "GIG Logistics", estimatedDays: 2, price: 2500, currency: "NGN" },
          { id: "dhl", name: "DHL Express", estimatedDays: 1, price: 5800, currency: "NGN" },
          { id: "kwik", name: "Kwik Delivery", estimatedDays: 1, price: 1800, currency: "NGN" },
          { id: "sendbox", name: "Sendbox", estimatedDays: 3, price: 1500, currency: "NGN" },
        ];
      }
      try {
        const data = await shipbubbleRequest("/shipping/rates", "POST", {
          sender: { postcode: input.senderPostcode },
          recipient: { postcode: input.recipientPostcode },
          package: { weight: input.weightKg },
        }, key);
        return data.rates ?? [];
      } catch {
        return [];
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

  // Simulate delivery (for demo/testing — triggers the same flow as a real webhook)
  simulateDelivery: protectedProcedure
    .input(z.object({
      shipmentId: z.string(),
      status: z.enum(["picked_up", "in_transit", "out_for_delivery", "delivered", "failed"]).default("delivered"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const [shipment] = await db.select().from(logisticsShipments)
        .where(eq(logisticsShipments.id, input.shipmentId));
      if (!shipment) throw new Error("Shipment not found");

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
