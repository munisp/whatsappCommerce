/**
 * J10 — Shipment + PIN + reaction: createShipment → buyer push with the
 * 4-digit delivery PIN + tracking link (delivery coords propagate from the
 * native-location checkout); a 👍 reaction gets the current order status.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J10",
  name: "shipment PIN + reaction",
  feature: "createShipment → PIN push → reaction status",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    // Delivery order via native location so coords are on the order.
    await nlpAddToCart(world, phone, "one jollof please", [{ product: "Jollof Rice", quantity: 1 }]);
    await nlpConfirm(world, phone, "confirm it");
    await world.text(phone, "2");
    await world.waitFor(() => world.outbound.lastOfType("interactive", phone) != null, 8000, "location_request sent");
    await world.location(phone, 6.4281, 3.4219, "Home", "12 Adeola Odeku Street, Victoria Island, Lagos");

    const schema = await import("../../drizzle/schema");
    const { desc } = await import("drizzle-orm");
    const [order] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.customerId, phone)).orderBy(desc(schema.orders.createdAt)).limit(1);
    assert(order, "delivery order created");

    const caller = await adminCaller();
    const before = world.outbound.toPhone(phone).length;
    const shipment = await caller.logistics.createShipment({
      orderId: order.id,
      tenantId: TENANT_ID,
      carrierName: "Sim Logistics",
      senderName: "Sim Store",
      senderPhone: "2347000000000",
      senderAddress: { street: "1 Warehouse Rd", city: "Lagos", state: "Lagos", country: "NG" },
      recipientName: "Sim Buyer",
      recipientPhone: phone,
      recipientAddress: { street: "12 Adeola Odeku Street", city: "Lagos", state: "Lagos", country: "NG" },
    });
    assert(shipment?.id, "shipment created");
    assert(shipment.deliveryPin && /^\d{4}$/.test(shipment.deliveryPin), `4-digit PIN generated (got ${shipment.deliveryPin})`);

    await world.waitFor(() => world.outbound.toPhone(phone).length > before, 8000, "buyer push sent");
    const push = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(push, "delivery PIN", "buyer push mentions the delivery PIN");
    assertIncludes(push, shipment.deliveryPin!, "push contains the actual PIN");
    assertIncludes(push, "Track your order", "push contains a tracking link");

    const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1);
    assert(o.status === "shipped", "order status advanced to shipped");

    // Shipment inherits the delivery coords collected by the native flow.
    const shipMeta = shipment.metadata as any;
    assert(shipMeta?.deliveryCoords?.latitude === 6.4281, "shipment metadata carries delivery coords");

    // ── Reaction on the status message → current status reply ────────────
    await world.reaction(phone, "wamid.sim.in.text.00001", "👍");
    const reactionReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reactionReply, "Thanks for the reaction", "reaction acknowledged");
    assertIncludes(reactionReply, "shipped", "reaction reply reports the current (shipped) status");
    assertIncludes(reactionReply, "/track/", "reaction reply includes tracking link");
  },
};
