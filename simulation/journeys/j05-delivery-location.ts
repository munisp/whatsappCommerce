/**
 * J5 — Delivery + fee + native location: delivery choice → location_request
 * interactive → location message → coords persisted in order metadata,
 * delivery fee folded into the payment total.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J05",
  name: "delivery + native location",
  feature: "location_request → coords + fee",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    await nlpAddToCart(world, phone, "one jollof rice please", [{ product: "Jollof Rice", quantity: 1 }]);
    await nlpConfirm(world, phone, "confirm it");

    // Choose delivery → native location request prompt.
    await world.text(phone, "2");
    await world.waitFor(() => world.outbound.lastOfType("interactive", phone) != null, 8000, "location_request interactive sent");
    const locReq = world.outbound.lastOfType("interactive", phone);
    assert(locReq, "delivery choice produced an interactive prompt");
    assert(
      locReq.body?.interactive?.type === "location_request_message",
      `interactive is a location_request_message (got ${locReq.body?.interactive?.type})`,
    );

    // Buyer shares their location natively.
    await world.location(phone, 6.4281, 3.4219, "Home", "12 Adeola Odeku Street, Victoria Island, Lagos");

    const orderMsg = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderMsg, "Delivery fee", "delivery fee line shown");
    assertIncludes(orderMsg, "1,500.00", "same-city fee is ₦1,500");
    assertIncludes(orderMsg, "₦4,000.00", "total includes the fee (2500 + 1500)");
    assertIncludes(orderMsg, "https://checkout.paystack.com/sim/", "payment link on the fee-inclusive total");

    const schema = await import("../../drizzle/schema");
    const [order] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.customerId, phone)).limit(1);
    assert(order, "order created");
    assert(Number(order.totalAmount) === 4000, `total 4000 (got ${order.totalAmount})`);
    const meta = order.metadata as any;
    assert(meta?.fulfillment === "delivery", "fulfillment is delivery");
    assert(meta?.deliveryCoords?.latitude === 6.4281, "delivery coords latitude persisted");
    assert(meta?.deliveryCoords?.longitude === 3.4219, "delivery coords longitude persisted");
    assertIncludes(JSON.stringify(order.shippingAddress ?? {}), "Adeola Odeku", "delivery address persisted in shippingAddress");
    assert(Number(meta?.deliveryFee) === 1500, "deliveryFee recorded in metadata");
    assert(meta?.deliveryZone === "same_city", "delivery zone recorded");

    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, order.id)).limit(1);
    assert(Number(tx?.amount) === 4000, "payment tx charges the fee-inclusive total");
  },
};
