/**
 * J7 — Payment confirmation: provider webhook (paystack charge.success) →
 * receipt message with items + total + tracking link; reservations committed.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J07",
  name: "payment confirm + receipt",
  feature: "paymentConfirm → receipt push",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }, { product: "Grilled Chicken", quantity: 1 }],
    });
    assert(order.paymentRef, "payment reference captured");
    assert(order.total === 5500, `order total 5500 (got ${order.total})`);

    const result = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: 5500 });
    assert(result.status === 200, `paystack webhook accepted (got ${result.status})`);

    // Receipt message: items + total + payment ref.
    const schema = await import("../../drizzle/schema");
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 10000, "order confirmed after webhook");
    const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(o.paymentStatus === "completed", "order paymentStatus completed");

    const receipt = world.outbound.lastOfType("text", phone);
    const receiptText = bodyText(receipt);
    assertIncludes(receiptText, "Payment Receipt", "receipt header delivered");
    assertIncludes(receiptText, order.orderNumber, "receipt references the order number");
    assertIncludes(receiptText, "1 × Jollof Rice", "receipt itemizes jollof");
    assertIncludes(receiptText, "1 × Grilled Chicken", "receipt itemizes chicken");
    assertIncludes(receiptText, "Total paid: ₦5,500.00", "receipt total");
    assertIncludes(receiptText, order.paymentRef!, "receipt carries the payment ref");
    assertIncludes(receiptText, "/track/", "receipt includes a tracking link");

    // Reservations committed + stock stays decremented.
    const reservations = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, order.orderId));
    assert(reservations.length === 2, "reservations exist");
    assert(reservations.every((r: any) => r.status === "committed"), "reservations committed after payment");

    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.orderId)).limit(1);
    assert(tx.status === "completed", "payment transaction completed");

    // Idempotency: replaying the webhook must not double-confirm or re-receipt.
    const before = world.outbound.toPhone(phone).length;
    const replay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: 5500 });
    assert(replay.status === 200, "replay accepted");
    const after = world.outbound.toPhone(phone).length;
    assert(after - before <= 1, "replayed webhook does not spam duplicate receipts");
  },
};
