/**
 * The handover: what a rider does at the customer's door, from the driver app or a shop's rider link.
 *
 *  1. The customer's delivery PIN (from their receipt) is checked when the order's shipment has one, with the
 *     existing timing-safe check and daily attempt cap (logistics.ts).
 *  2. A photo is required when the shop has switched it on (tenants.requirePod); otherwise it's optional.
 *  3. With a photo, it's stored as the order's proof of delivery (deliveryProof.recordDeliveryProof), which also
 *     completes the delivery; without one, the delivery is completed directly (completeDeliveryWithProof). Either
 *     way: order + shipment delivered, escrow released, customer told — the same path the courier API uses.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { logisticsShipments, orders } from "../../../drizzle/schema";
import type { getDb } from "../../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface HandoverInput {
  tenantId: string;
  orderId: string;
  pin?: string | null;
  photo?: { buffer: Buffer; mimeType: string } | null;
  via: "driver_app" | "rider_link";
  driverId?: string | null;
}

export interface HandoverView {
  needsPin: boolean;
  photoRequired: boolean;
}

/** What the handover will ask for, for this order. */
export async function handoverRequirements(db: Db, tenantId: string, orderId: string): Promise<HandoverView> {
  const [shipment] = await db.select({ deliveryPin: logisticsShipments.deliveryPin }).from(logisticsShipments)
    .where(and(eq(logisticsShipments.tenantId, tenantId), eq(logisticsShipments.orderId, orderId)))
    .orderBy(desc(logisticsShipments.createdAt)).limit(1).catch(() => [] as any[]);
  const { tenantRequiresPod } = await import("../deliveryProof");
  return { needsPin: !!shipment?.deliveryPin, photoRequired: await tenantRequiresPod(db, tenantId) };
}

export async function confirmHandover(db: Db, input: HandoverInput): Promise<{ delivered: true; photo: boolean }> {
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.tenantId, input.tenantId))).limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "This order wasn't found." });
  if (order.status === "delivered") return { delivered: true, photo: false };
  if (["cancelled", "refunded"].includes(order.status)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This order was cancelled, so it can't be delivered." });
  }

  const [shipment] = await db.select().from(logisticsShipments)
    .where(and(eq(logisticsShipments.tenantId, input.tenantId), eq(logisticsShipments.orderId, order.id)))
    .orderBy(desc(logisticsShipments.createdAt)).limit(1).catch(() => [] as any[]);

  if (shipment?.deliveryPin) {
    const pin = (input.pin ?? "").trim();
    if (!pin) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the customer's delivery PIN. It's in their payment receipt on WhatsApp." });
    const { claimPinAttempt, verifyDeliveryPin } = await import("../../routers/logistics");
    if (!(await claimPinAttempt(db, shipment.id))) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many wrong PINs today. Ask the shop to confirm this delivery." });
    }
    if (!verifyDeliveryPin(shipment.deliveryPin, pin, shipment.id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That PIN doesn't match. Check it with the customer." });
    }
  }

  const { tenantRequiresPod, recordDeliveryProof, completeDeliveryWithProof } = await import("../deliveryProof");
  const photo = input.photo && input.photo.buffer.length > 0 ? input.photo : null;
  if (photo) {
    if (photo.buffer.length > MAX_PHOTO_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "That photo is too big (8 MB at most)." });
    if (!PHOTO_TYPES.has(photo.mimeType)) throw new TRPCError({ code: "BAD_REQUEST", message: "The photo must be a JPG, PNG or WebP." });
  } else if (await tenantRequiresPod(db, input.tenantId)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This shop needs a photo of the delivery. Take one, then mark it delivered." });
  }

  if (photo) {
    await recordDeliveryProof(db, {
      tenantId: input.tenantId, orderId: order.id, mediaBuffer: photo.buffer, mimeType: photo.mimeType,
      capturedVia: input.via, capturedByDriverId: input.driverId ?? null,
    } as any);
  } else {
    await completeDeliveryWithProof(db, { tenantId: input.tenantId, order, shipment: shipment ?? null, at: new Date() });
  }
  return { delivered: true, photo: !!photo };
}

/** Decodes a base64 photo from a browser (with or without a data: prefix). */
export function decodePhoto(base64: string | null | undefined, mimeType: string | null | undefined): { buffer: Buffer; mimeType: string } | null {
  if (!base64) return null;
  const body = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const buffer = Buffer.from(body, "base64");
  return buffer.length ? { buffer, mimeType: (mimeType || "image/jpeg").toLowerCase() } : null;
}
