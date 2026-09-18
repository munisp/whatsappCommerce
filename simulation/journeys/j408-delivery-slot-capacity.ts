// === W46 uc-ux (Coder E) ===
/**
 * J408 — UC-21: delivery slot picker with claim-first capacity (never
 * oversold, idempotent re-book, release on cancel), courier booking seam on
 * the order metadata, and both-channels picker/confirmation text.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedCartWithProduct } from "./w46-uc-ux-seed";

export const journey: Journey = {
  id: "J408",
  name: "delivery slots: capacity claim-first, picker, courier seam",
  feature: "UC-21 delivery_slots + checkout slot picker + courier booking seam",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/deliverySlots");
    const { createChatOrder } = await import("../../server/routers/nlp");
    const phone = world.newPhone("j408");
    await world.grantConsent(phone);
    const slotDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // Capacity 1 slot: first booking wins, second is refused.
    const slot = await svc.createDeliverySlot(world.db, { tenantId: TENANT_ID, slotDate, startTime: "14:00", endTime: "16:00", capacity: 1 });

    const mk = async (tag: string) => {
      const { cartSessionId } = await seedCartWithProduct(world, tag, phone, { unitPrice: "3000.00" });
      const order = await createChatOrder(world.db, {
        tenantId: TENANT_ID, waPhoneNumber: phone, cartSessionId, fulfillment: "pickup", address: null,
      });
      assert(order.created === true, `order ${tag} created: ${JSON.stringify(order)}`);
      return order.orderId!;
    };
    const orderA = await mk("j408a");
    const orderB = await mk("j408b");

    const b1 = await svc.bookDeliverySlot(world.db, { tenantId: TENANT_ID, orderId: orderA, slotId: slot.id });
    assert(b1.booked === true, "first booking claims the seat");
    const b2 = await svc.bookDeliverySlot(world.db, { tenantId: TENANT_ID, orderId: orderB, slotId: slot.id });
    assert(b2.booked === false && b2.reason === "slot_full", "capacity 1 refuses the second claim");
    // Idempotent replay of the SAME booking.
    const replay = await svc.bookDeliverySlot(world.db, { tenantId: TENANT_ID, orderId: orderA, slotId: slot.id });
    assert(replay.booked === true, "replay of the same order+slot is a no-op success");
    const [slotRow] = await world.db.select().from(schema.deliverySlots).where(eq(schema.deliverySlots.id, slot.id));
    assert(slotRow.bookedCount === 1, `booked_count exactly 1 after replay (got ${slotRow.bookedCount})`);
    const [ordA] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderA));
    assert(ordA.deliverySlotId === slot.id, "orders.deliverySlotId stamped");

    // Release frees capacity for the waiting order.
    const rel = await svc.releaseDeliverySlot(world.db, { tenantId: TENANT_ID, orderId: orderA });
    assert(rel.released === true, "release frees the seat");
    const b3 = await svc.bookDeliverySlot(world.db, { tenantId: TENANT_ID, orderId: orderB, slotId: slot.id });
    assert(b3.booked === true, "released slot can be rebooked");

    // Picker list shows remaining capacity and drops full slots.
    const wide = await svc.createDeliverySlot(world.db, { tenantId: TENANT_ID, slotDate, startTime: "18:00", endTime: "20:00", capacity: 5 });
    const list = await svc.listAvailableSlots(world.db, TENANT_ID);
    assert(list.some((s) => s.id === wide.id && s.remaining === 5), "picker lists slots with remaining capacity");
    assert(!list.some((s) => s.id === slot.id), "full slot hidden from the picker");
    const picker = svc.formatSlotPicker(list);
    assert(picker.includes("Pick a delivery slot"), "picker text rendered (identical on both channels)");

    // Courier booking seam records the booking intent on order metadata.
    const seam = await svc.bookCourierForSlot(world.db, { tenantId: TENANT_ID, orderId: orderB, slotId: slot.id, dropoffAddress: "1 Sim Street" });
    assert(seam.seam === "quoted" || seam.seam === "pending", "courier seam returns an honest status");
    const [ordB] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderB));
    assert((ordB.metadata as any)?.courierBooking?.slotId === slot.id, "courier booking seam persisted on metadata");

    // Parity category registered (J246 subset semantics).
    const parity = await import("../../server/services/channelParity");
    assert(parity.getParityCategory("delivery_slot")?.telegram === "full", "delivery_slot parity category registered");
  },
};
// === END W46 uc-ux ===
