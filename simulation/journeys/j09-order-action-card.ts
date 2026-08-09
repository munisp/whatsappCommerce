/**
 * J9 — Order action card: [Track][Pay][Cancel] button replies drive the
 * order; a foreign phone cannot cancel someone else's order.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J09",
  name: "order action card",
  feature: "track/pay/cancel buttons",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Grilled Chicken", quantity: 1 }],
    });
    const schema = await import("../../drizzle/schema");

    // ── Track ────────────────────────────────────────────────────────────
    await world.buttonReply(phone, `order_track:${order.orderId}`, "Track Order");
    const trackReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(trackReply, order.orderNumber, "track reply references the order number");
    assertIncludes(trackReply, "pending", "track reply reports the current status");
    assertIncludes(trackReply, "/track/", "track reply includes a tracking link");

    // ── Pay (resend link) ────────────────────────────────────────────────
    await world.buttonReply(phone, `order_pay:${order.orderId}`, "Pay Now");
    const payReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(payReply, "https://checkout.paystack.com/sim/", "pay reply resends the payment link");

    // ── Foreign phone cannot cancel ──────────────────────────────────────
    const stranger = world.newPhone("b");
    await world.grantConsent(stranger);
    await world.buttonReply(stranger, `order_cancel:${order.orderId}`, "Cancel Order");
    const strangerReply = bodyText(world.outbound.lastOfType("text", stranger));
    assertIncludes(strangerReply, "couldn't find that order", "foreign phone told the order isn't theirs");
    const [stillPending] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(stillPending.status === "pending", "order NOT cancelled by a foreign phone");

    // ── Owner cancel → cancelled + stock released ────────────────────────
    const [chickenBefore] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-chicken")).limit(1);
    await world.buttonReply(phone, `order_cancel:${order.orderId}`, "Cancel Order");
    const cancelReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(cancelReply, "has been cancelled", "owner cancel confirmed");
    const [cancelled] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(cancelled.status === "cancelled", "order status cancelled");
    const reservations = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, order.orderId));
    assert(reservations.every((r: any) => r.status === "released"), "reservations released on cancel");
    const [chickenAfter] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-chicken")).limit(1);
    assert(
      chickenAfter.stockQuantity === chickenBefore.stockQuantity + 1,
      `stock released back (${chickenBefore.stockQuantity} → ${chickenAfter.stockQuantity})`,
    );

    // ── Pay on a cancelled order is refused ──────────────────────────────
    const beforePayCancelled = world.outbound.toPhone(phone).length;
    await world.buttonReply(phone, `order_pay:${order.orderId}`, "Pay Now");
    const payCancelled = world.outbound.toPhone(phone).slice(beforePayCancelled).map((c) => bodyText(c)).join("\n");
    assert(!payCancelled.includes("checkout.paystack.com"), "no payment link resent for a cancelled order");
  },
};
