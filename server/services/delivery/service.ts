/**
 * server/services/delivery/service.ts — W27 delivery aggregation orchestration.
 *
 * Checkout quote → merchant booking → status sync, feeding the EXISTING
 * deliveryReceipts / orderStatus / escrow flow:
 *
 * - quoteOrderDelivery(): resolves the tenant's courier adapters, collects
 *   deterministic quotes, and returns the cheapest (tie-break: courier id).
 *   The fee surfaces in integer cents; callers rendering the legacy NGN-major
 *   shape use `feeMajor`.
 * - bookDelivery(): merchant books the accepted quote with the winning
 *   courier; the delivery row snapshots the quote for reconciliation.
 * - syncDeliveryStatus() / advanceDeliveryStatus(): pull the courier's latest
 *   status; on `delivered` this (1) flips the order to delivered, (2) moves
 *   any escrow_held transaction to delivery_confirmed — the EXISTING escrow
 *   release path (buyerConfirm / SLA sweep) then releases funds. escrow.ts is
 *   NOT edited; this mirrors the logistics.ts delivered-handshake.
 * - On delivery the buyer gets a WhatsApp status push + review prompt and the
 *   order's loyalty points vest (loyalty.awardPointsForOrder, idempotent).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { deliveries, escrowTransactions, merchantLocations, orders } from "../../../drizzle/schema";
import { toMinorUnitsExact } from "../../../shared/escrowAmounts";
import { quoteDeliveryFee } from "../deliveryQuote";
import { awardPointsForOrder } from "../loyalty";
import { sendWhatsAppText } from "../waSender";
import { getCourierAdapter, getCouriersForTenant } from "./registry";
import type { Booking, DeliveryState, Quote, QuoteRequest } from "./types";
import type { getDb } from "../../db";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface AggregatedQuote {
  courier: string;
  quoteId: string;
  /** INTEGER CENTS — the fee added to the order total. */
  feeCents: number;
  /** NGN-major units (number) for the legacy createChatOrder rendering. */
  feeMajor: number;
  currency: string;
  distanceKm: number | null;
  etaMinutes: number;
  label: string;
  zone: "same_city" | "intercity" | null;
  source: "courier_adapter" | "fallback_zone_rate";
  /** All quotes considered, cheapest first (portal quote comparison). */
  quotes: Quote[];
}

/** Load the merchant's primary branch (first merchant_locations row). */
export async function getMerchantPickup(db: Db, tenantId: string) {
  const [loc] = await db.select().from(merchantLocations)
    .where(eq(merchantLocations.tenantId, tenantId)).limit(1).catch(() => []);
  if (!loc) return null;
  return {
    lat: Number(loc.latitude),
    lng: Number(loc.longitude),
    address: loc.addressLine ?? ([loc.city, loc.country].filter(Boolean).join(", ") || null),
  };
}

/**
 * Quote a delivery for checkout. Coordinates (buyer pin) give exact distance
 * pricing via the local-dispatch adapter; free-text addresses fall back to
 * zone rates. Never throws on adapter failure — falls back to the honest
 * zone rate so checkout is never blocked by a courier outage.
 */
export async function quoteOrderDelivery(
  db: Db,
  opts: {
    tenantId: string;
    dropoffAddress?: string | null;
    dropoffLat?: number | null;
    dropoffLng?: number | null;
    weightKg?: number;
    orderValueCents?: number;
    currency?: string;
  },
): Promise<AggregatedQuote> {
  const pickup = await getMerchantPickup(db, opts.tenantId);
  const req: QuoteRequest = {
    tenantId: opts.tenantId,
    pickup,
    dropoff:
      typeof opts.dropoffLat === "number" && typeof opts.dropoffLng === "number"
        ? { lat: opts.dropoffLat, lng: opts.dropoffLng }
        : null,
    dropoffAddress: opts.dropoffAddress ?? null,
    weightKg: opts.weightKg,
    orderValueCents: opts.orderValueCents,
    currency: opts.currency ?? "NGN",
  };

  const couriers = await getCouriersForTenant(opts.tenantId);
  const quotes: Quote[] = [];
  for (const entry of couriers) {
    try {
      quotes.push(await entry.courier.quote(req));
    } catch (e: any) {
      console.warn(`[delivery] quote from ${entry.courier.id} failed:`, e?.message);
    }
  }

  if (quotes.length === 0) {
    // Absolute fallback: honest zone rate (published carrier anchors).
    const zone = quoteDeliveryFee({ address: opts.dropoffAddress, weightKg: opts.weightKg });
    const feeCents = Math.round(zone.fee * 100);
    return {
      courier: "zone_fallback",
      quoteId: `zone_${zone.zone}`,
      feeCents,
      feeMajor: zone.fee,
      currency: zone.currency,
      distanceKm: null,
      etaMinutes: zone.estimatedDays * 24 * 60,
      label: `Delivery (${zone.zone === "same_city" ? "same city" : "intercity"} estimate)`,
      zone: zone.zone,
      source: "fallback_zone_rate",
      quotes: [],
    };
  }

  // Cheapest wins; deterministic tie-break by courier id then quoteId.
  quotes.sort((a, b) => a.feeCents - b.feeCents || a.courier.localeCompare(b.courier) || a.quoteId.localeCompare(b.quoteId));
  const best = quotes[0];
  return {
    courier: best.courier,
    quoteId: best.quoteId,
    feeCents: best.feeCents,
    feeMajor: best.feeCents / 100,
    currency: best.currency,
    distanceKm: best.distanceKm,
    etaMinutes: best.etaMinutes,
    label: best.label,
    zone: null,
    source: "courier_adapter",
    quotes,
  };
}

/**
 * Book a delivery for an order with the given courier (defaults to the
 * courier recorded on the order's checkout quote, else the cheapest current
 * quote). Snapshots the quote into the delivery row.
 */
export async function bookDelivery(
  db: Db,
  opts: { tenantId: string; orderId: string; courier?: string; notes?: string | null },
): Promise<{ delivery: typeof deliveries.$inferSelect; booking: Booking }> {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId))).limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

  const meta = (order.metadata as Record<string, unknown> | null) ?? {};
  const storedQuote = meta.deliveryQuote as { courier?: string; quoteId?: string; feeCents?: number } | undefined;
  const courierName = opts.courier ?? storedQuote?.courier;
  if (!courierName || courierName === "zone_fallback") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No bookable courier on this order — quote with a courier adapter first" });
  }
  const adapter = getCourierAdapter(courierName);
  if (!adapter) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown courier: ${courierName}` });

  // Idempotency: one active delivery per order.
  const [existing] = await db.select().from(deliveries)
    .where(and(eq(deliveries.orderId, order.id), eq(deliveries.tenantId, opts.tenantId)))
    .orderBy(desc(deliveries.createdAt)).limit(1);
  if (existing && !["cancelled", "failed"].includes(existing.status)) {
    return { delivery: existing, booking: { courier: existing.courier, externalId: existing.externalId ?? "", status: existing.status as DeliveryState } };
  }

  const pickup = await getMerchantPickup(db, opts.tenantId);
  const dropCoords = (meta.deliveryCoords as { latitude?: number; longitude?: number } | undefined) ?? undefined;
  const quote: Quote = {
    courier: courierName,
    quoteId: storedQuote?.quoteId ?? `requote_${order.id}`,
    feeCents: storedQuote?.feeCents ?? toMinorUnitsExact(String(meta.deliveryFee ?? "0")),
    currency: order.currency,
    distanceKm: null,
    etaMinutes: 60,
    label: "Booked from checkout quote",
  };
  const booking = await adapter.book({
    tenantId: opts.tenantId,
    orderId: order.id,
    quote,
    pickup: pickup ? { address: pickup.address, lat: pickup.lat, lng: pickup.lng } : null,
    dropoff: {
      phone: order.customerId,
      address: (order.shippingAddress as { raw?: string } | null)?.raw ?? null,
      ...(typeof dropCoords?.latitude === "number" && typeof dropCoords?.longitude === "number"
        ? { lat: dropCoords.latitude, lng: dropCoords.longitude }
        : {}),
    },
    notes: opts.notes ?? null,
  });

  const now = new Date();
  const [delivery] = await db.insert(deliveries).values({
    tenantId: opts.tenantId,
    orderId: order.id,
    courier: courierName,
    externalId: booking.externalId,
    status: "booked",
    feeCents: quote.feeCents,
    currency: quote.currency,
    quote: quote as unknown as Record<string, unknown>,
    pickupAddress: pickup ? { address: pickup.address, lat: pickup.lat, lng: pickup.lng } : null,
    dropoffAddress: order.shippingAddress as Record<string, unknown> | null,
    recipientPhone: order.customerId,
    statusHistory: [{ status: "booked", at: now.toISOString() }],
    bookedAt: now,
  }).returning();
  return { delivery: delivery!, booking };
}

/** Delivery states that may advance the stored status (ordered). */
const STATE_ORDER: DeliveryState[] = ["quoted", "booked", "picked_up", "in_transit", "delivered"];

/**
 * Apply a courier status to the delivery row and feed the existing
 * order-status / escrow / loyalty / WhatsApp flows. Exported for both the
 * status sync sweep and the simulation/merchant-driven advance path.
 */
export async function applyDeliveryStatus(
  db: Db,
  deliveryId: string,
  next: { status: DeliveryState; at?: string },
): Promise<{ transitioned: boolean; status: string }> {
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
  if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });

  const currentIdx = STATE_ORDER.indexOf(delivery.status as DeliveryState);
  const nextIdx = STATE_ORDER.indexOf(next.status);
  const terminal = ["delivered", "failed", "cancelled"].includes(delivery.status);
  // Allow forward moves along STATE_ORDER, and failure/cancel from non-terminal.
  const forward = nextIdx > currentIdx && !terminal;
  const failing = ["failed", "cancelled"].includes(next.status) && !terminal;
  if (!forward && !failing) {
    return { transitioned: false, status: delivery.status };
  }

  const at = next.at ?? new Date().toISOString();
  const history = [...(Array.isArray(delivery.statusHistory) ? (delivery.statusHistory as unknown[]) : []), { status: next.status, at }];
  await db.update(deliveries).set({
    status: next.status,
    statusHistory: history as Record<string, unknown>[],
    ...(next.status === "delivered" ? { deliveredAt: new Date(at) } : {}),
    updatedAt: new Date(),
  }).where(eq(deliveries.id, delivery.id));

  if (next.status === "delivered") {
    // 1. Order status (existing flow).
    await db.update(orders).set({ status: "delivered", updatedAt: new Date() })
      .where(and(eq(orders.id, delivery.orderId), eq(orders.tenantId, delivery.tenantId)));

    // 2. Escrow tie-in (event-style; escrow.ts untouched): move escrow_held →
    //    delivery_confirmed so the EXISTING buyerConfirm / SLA sweep releases.
    await db.update(escrowTransactions).set({
      state: "delivery_confirmed",
      deliveryConfirmedAt: new Date(at),
      updatedAt: new Date(),
    }).where(and(
      eq(escrowTransactions.orderId, delivery.orderId),
      eq(escrowTransactions.state, "escrow_held"),
    )).catch(() => {});

    // 3. Loyalty points vest on delivery (idempotent).
    await awardPointsForOrder(db, delivery.tenantId, delivery.orderId).catch(() => {});

    // 4. Buyer WhatsApp push + review prompt (fire-and-forget).
    const [order] = await db.select().from(orders).where(eq(orders.id, delivery.orderId)).limit(1).catch(() => []);
    if (order && /^\+?\d{7,15}$/.test(order.customerId)) {
      sendWhatsAppText(delivery.tenantId, order.customerId,
        `📦 Your order ${order.orderNumber} has been delivered! Enjoy 🎉\n\nHow was it? Reply e.g. "RATE 5 Great service!" to leave a review, or text POINTS to see your loyalty balance.`,
        { notifType: "delivery_completed", orderId: order.id },
      ).catch((e: any) => console.warn("[delivery] buyer delivered push failed:", e?.message));
    }
  }
  return { transitioned: true, status: next.status };
}

/** Pull the courier's current status for a booked delivery and apply it. */
export async function syncDeliveryStatus(
  db: Db,
  deliveryId: string,
): Promise<{ transitioned: boolean; status: string }> {
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
  if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
  const adapter = getCourierAdapter(delivery.courier);
  if (!adapter || !delivery.externalId) return { transitioned: false, status: delivery.status };
  const latest = await adapter.status(delivery.externalId);
  return applyDeliveryStatus(db, deliveryId, { status: latest.status, at: latest.at });
}

/**
 * Sweep: sync all in-flight deliveries for a tenant (or all tenants).
 * Safe for cron — applyDeliveryStatus guards monotonic transitions and the
 * delivered side-effects are idempotent (escrow state guard, earn dedupe).
 */
export async function sweepDeliveryStatus(
  db: Db,
  tenantId?: string,
): Promise<{ scanned: number; advanced: number }> {
  const rows = await db.select({ id: deliveries.id })
    .from(deliveries)
    .where(and(
      sql`${deliveries.status} IN ('booked','picked_up','in_transit')`,
      ...(tenantId ? [eq(deliveries.tenantId, tenantId)] : []),
    )).catch(() => []);
  let advanced = 0;
  for (const r of rows) {
    const res = await syncDeliveryStatus(db, r.id).catch(() => ({ transitioned: false, status: "" }));
    if (res.transitioned) advanced += 1;
  }
  return { scanned: rows.length, advanced };
}

/** List deliveries for the portal (newest first). */
export async function listDeliveries(db: Db, tenantId: string, limit = 50) {
  return db.select().from(deliveries)
    .where(eq(deliveries.tenantId, tenantId))
    .orderBy(desc(deliveries.createdAt))
    .limit(Math.min(200, limit));
}
