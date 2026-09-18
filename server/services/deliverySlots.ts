// === W46 uc-ux (Coder E): UC-21 — delivery slots + capacity + courier seam ===
/**
 * deliverySlots.ts — per-tenant delivery time slots with hard capacity.
 *
 * - `listAvailableSlots` powers the checkout slot picker on BOTH channels
 *   (the shared nlp engine renders the same numbered list for WA + TG).
 * - `bookDeliverySlot` is CLAIM-FIRST: a guarded UPDATE
 *   (booked_count < capacity) atomically claims one seat, then the order row
 *   is stamped with deliverySlotId. Concurrent checkouts can never oversell
 *   a slot; the second claim returns { booked:false } and the buyer is asked
 *   to pick another slot.
 * - `releaseDeliverySlot` decrements on pre-dispatch cancel (guarded > 0).
 * - Courier seam: `bookCourierForSlot` links the booked slot to the W27
 *   aggregated courier quote machinery (delivery/service.quoteOrderDelivery)
 *   as an adjacent seam and records the booking intent on the order's
 *   metadata — dispatch itself stays with the existing delivery service.
 */

import { and, asc, eq, gte, sql } from "drizzle-orm";
import { deliverySlots, orders } from "../../drizzle/schema";
import { sendCustomerText } from "./channelParity";

type Db = any;

export async function createDeliverySlot(
  db: Db,
  opts: { tenantId: string; slotDate: string; startTime: string; endTime: string; capacity: number },
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.slotDate)) throw new Error("slotDate must be YYYY-MM-DD");
  if (!(opts.capacity > 0)) throw new Error("capacity must be positive");
  const [row] = await db.insert(deliverySlots).values({
    tenantId: opts.tenantId,
    slotDate: opts.slotDate,
    startTime: opts.startTime,
    endTime: opts.endTime,
    capacity: Math.floor(opts.capacity),
  }).returning({ id: deliverySlots.id });
  return row;
}

/** Slots with remaining capacity, today onward, soonest first (picker list). */
export async function listAvailableSlots(
  db: Db,
  tenantId: string,
  opts: { fromDate?: string; limit?: number } = {},
): Promise<Array<{ id: string; slotDate: string; startTime: string; endTime: string; remaining: number }>> {
  const fromDate = opts.fromDate ?? new Date().toISOString().slice(0, 10);
  const rows = await db.select().from(deliverySlots)
    .where(and(
      eq(deliverySlots.tenantId, tenantId),
      eq(deliverySlots.active, true),
      gte(deliverySlots.slotDate, fromDate),
      sql`${deliverySlots.bookedCount} < ${deliverySlots.capacity}`,
    ))
    .orderBy(asc(deliverySlots.slotDate), asc(deliverySlots.startTime))
    .limit(opts.limit ?? 10);
  return rows.map((r: any) => ({
    id: r.id,
    slotDate: r.slotDate,
    startTime: r.startTime,
    endTime: r.endTime,
    remaining: r.capacity - r.bookedCount,
  }));
}

/** Human picker text, identical on both channels. */
export function formatSlotPicker(slots: Array<{ slotDate: string; startTime: string; endTime: string; remaining: number }>): string {
  if (slots.length === 0) return "No delivery slots are available right now — your order will be scheduled as soon as possible.";
  const lines = slots.map((s, i) => `${i + 1}. ${s.slotDate} ${s.startTime}–${s.endTime} (${s.remaining} left)`);
  return "🕒 *Pick a delivery slot:*\n" + lines.join("\n") + "\nReply with the slot number (e.g. SLOT 1).";
}

/**
 * Claim-first booking: atomically increments booked_count when below
 * capacity, then stamps orders.deliverySlotId. Exactly-once per order —
 * re-booking the same order onto the same slot is a no-op.
 */
export async function bookDeliverySlot(
  db: Db,
  opts: { tenantId: string; orderId: string; slotId: string },
): Promise<{ booked: boolean; reason?: string }> {
  const [order] = await db.select({ id: orders.id, deliverySlotId: orders.deliverySlotId })
    .from(orders).where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId))).limit(1);
  if (!order) return { booked: false, reason: "order_not_found" };
  if (order.deliverySlotId === opts.slotId) return { booked: true }; // idempotent replay
  if (order.deliverySlotId) return { booked: false, reason: "already_booked" };
  const claimed = await db.execute(sql`
    UPDATE delivery_slots
    SET booked_count = booked_count + 1
    WHERE id = ${opts.slotId} AND tenant_id = ${opts.tenantId} AND active = true
      AND booked_count < capacity
    RETURNING id`);
  const rows = (claimed as any).rows ?? claimed;
  if (!rows || rows.length === 0) return { booked: false, reason: "slot_full" };
  await db.update(orders).set({ deliverySlotId: opts.slotId, updatedAt: new Date() })
    .where(eq(orders.id, opts.orderId));
  return { booked: true };
}

/** Release a slot claim (pre-dispatch cancel). Guarded: never below zero. */
export async function releaseDeliverySlot(
  db: Db,
  opts: { tenantId: string; orderId: string },
): Promise<{ released: boolean }> {
  const [order] = await db.select({ deliverySlotId: orders.deliverySlotId })
    .from(orders).where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId))).limit(1);
  if (!order?.deliverySlotId) return { released: false };
  await db.execute(sql`
    UPDATE delivery_slots SET booked_count = booked_count - 1
    WHERE id = ${order.deliverySlotId} AND booked_count > 0`);
  await db.update(orders).set({ deliverySlotId: null, updatedAt: new Date() })
    .where(eq(orders.id, opts.orderId));
  return { released: true };
}

/**
 * Courier booking seam: after a slot is booked on a delivery order, ask the
 * W27 aggregated courier service for a quote window and record the booking
 * intent on the order metadata ({courierBooking:{slotId,label,status}}).
 * Non-blocking/dispatch-agnostic — the actual dispatch stays with the
 * existing delivery pipeline at fulfillment time.
 */
export async function bookCourierForSlot(
  db: Db,
  opts: { tenantId: string; orderId: string; slotId: string; dropoffAddress?: string | null },
): Promise<{ seam: "quoted" | "pending"; label?: string }> {
  let label: string | undefined;
  try {
    const { quoteOrderDelivery } = await import("./delivery/service");
    const quote = await quoteOrderDelivery(db, {
      tenantId: opts.tenantId,
      dropoffAddress: opts.dropoffAddress ?? null,
    });
    label = quote?.label;
  } catch (e: unknown) {
    console.warn("[deliverySlots] courier quote seam failed (non-blocking):", (e as Error)?.message);
  }
  await db.execute(sql`
    UPDATE orders
    SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{courierBooking}',
          ${JSON.stringify({ slotId: opts.slotId, label: label ?? null, status: label ? "quoted" : "pending" })}::jsonb),
        "updatedAt" = now()
    WHERE id = ${opts.orderId}`);
  return label ? { seam: "quoted", label } : { seam: "pending" };
}

/** Buyer-facing confirmation on BOTH channels (parity category delivery_slot). */
export async function notifySlotBooked(
  db: Db,
  opts: { tenantId: string; phone: string; orderNumber: string; slotId: string },
): Promise<void> {
  const [slot] = await db.select().from(deliverySlots).where(eq(deliverySlots.id, opts.slotId)).limit(1);
  if (!slot) return;
  const body = `📅 Delivery slot confirmed for order ${opts.orderNumber}: ${slot.slotDate} ${slot.startTime}–${slot.endTime}. We'll message you when the courier is on the way!`;
  await sendCustomerText(opts.tenantId, opts.phone, "delivery_slot", body, { notifType: "delivery_slot_booked" });
}
// === END W46 uc-ux ===
