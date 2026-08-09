/**
 * J6 — Promo code: "use code SIM10" at checkout → discount line in the
 * summary and the discounted total in the payment link.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J06",
  name: "promo code discount",
  feature: "promos → discounted payment link",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    await nlpAddToCart(world, phone, "2 jollof rice", [{ product: "Jollof Rice", quantity: 2 }]);
    await nlpConfirm(world, phone, "confirm please");

    // Buyer mentions the code at the checkout step — it sticks to the session.
    await world.text(phone, "use code SIM10");
    const promoAck = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(promoAck, "SIM10", "promo code acknowledged at the checkout step");

    await world.text(phone, "1"); // pickup
    const orderMsg = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderMsg, "SIM10", "discount line shows the promo code");
    assertIncludes(orderMsg, "500", "10% of ₦5,000 = ₦500 discount appears");
    assertIncludes(orderMsg, "₦4,500.00", "discounted total shown");
    assertIncludes(orderMsg, "https://checkout.paystack.com/sim/", "payment link present");

    const schema = await import("../../drizzle/schema");
    const [order] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.customerId, phone)).limit(1);
    assert(order, "order created");
    assert(Number(order.totalAmount) === 4500, `order total discounted to 4500 (got ${order.totalAmount})`);
    const meta = order.metadata as any;
    assert(meta?.promo?.code === "SIM10", "promo code recorded in order metadata");
    assert(Number(meta?.promo?.discount) === 500, "discount amount recorded");

    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.id)).limit(1);
    assert(Number(tx?.amount) === 4500, "payment link amount is the discounted total");

    // An unknown code must NOT discount.
    const phone2 = world.newPhone("b");
    await world.grantConsent(phone2);
    await nlpAddToCart(world, phone2, "2 jollof rice too", [{ product: "Jollof Rice", quantity: 2 }]);
    await nlpConfirm(world, phone2, "confirm it too");
    await world.text(phone2, "use code NOPE99");
    await world.text(phone2, "1");
    const [order2] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.customerId, phone2)).limit(1);
    assert(Number(order2?.totalAmount) === 5000, "invalid promo leaves the total untouched");
  },
};
