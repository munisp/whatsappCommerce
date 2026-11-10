/**
 * J621 — a shop's own rider confirms a delivery from the rider link: the customer's PIN, a photo when the shop
 * requires one, then the order AND its shipment are delivered, the photo is the proof, and the customer is told.
 * (Built 2026-11-10: OAK had POD photos + delivery PINs in the backend but no rider-facing way to use them.)
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

export const journey: Journey = {
  id: "J621",
  name: "rider link: PIN + photo → delivered, proof stored, customer told",
  feature: "rider.view / rider.confirm handover (riderToken, handover.ts)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { appRouter } = await import("../../server/routers");
    const { hashDeliveryPin } = await import("../../server/routers/logistics");
    const { riderToken } = await import("../../server/services/riderToken");
    const { generateTrackingToken } = await import("../../server/services/trackingToken");
    const anon = appRouter.createCaller({ user: null } as any);
    const phone = world.newPhone("j621");
    const orderId = "j621-order", shipmentId = "00000000-0000-4000-8000-00000000j621".replace("j621", "0621");
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: phone, orderNumber: "SIM-J621", status: "shipped",
      totalAmount: "8000.00", currency: "NGN", paymentStatus: "completed",
      shippingAddress: { raw: "5 Admiralty Way, Lekki" }, metadata: { source: "whatsapp_chat", fulfillment: "delivery" },
    });
    await world.db.insert(schema.logisticsShipments).values({
      id: shipmentId, orderId, tenantId: TENANT_ID, provider: "manual", status: "out_for_delivery",
      deliveryPin: hashDeliveryPin("4821", shipmentId),
    } as any);
    const token = riderToken(orderId);

    const view = await anon.rider.view({ token });
    assert(view.orderNumber === "SIM-J621" && view.address === "5 Admiralty Way, Lekki", `the rider sees the order and address (got ${JSON.stringify(view)})`);
    assert(view.needsPin === true && view.photoRequired === false && !("totalAmount" in view), "it asks for the PIN, a photo is optional, and no price is shown");

    const refused = async (p: Promise<unknown>, what: string, code: string) => {
      try { await p; assert(false, `${what} should be refused`); } catch (e: any) { assert(e?.code === code, `${what}: refused with ${code} (got ${e?.code}: ${e?.message})`); }
    };
    await refused(anon.rider.view({ token: `${orderId}.forgedsignaturexxxxxxxxxxxxxxxxxx` }), "a forged link", "NOT_FOUND");
    await refused(anon.rider.confirm({ token: generateTrackingToken(orderId), pin: "4821" }), "the customer's tracking link used as a rider link", "NOT_FOUND");
    await refused(anon.rider.confirm({ token, pin: "1111" }), "a wrong PIN", "BAD_REQUEST");

    await world.db.update(schema.tenants).set({ requirePod: true }).where(eq(schema.tenants.id, TENANT_ID));
    try {
      await refused(anon.rider.confirm({ token, pin: "4821" }), "the right PIN with no photo, when the shop requires one", "PRECONDITION_FAILED");
      const done = await anon.rider.confirm({ token, pin: "4821", photoBase64: JPEG, photoMimeType: "image/jpeg" });
      assert(done.delivered === true && done.photo === true, `delivered with a photo (got ${JSON.stringify(done)})`);
    } finally {
      await world.db.update(schema.tenants).set({ requirePod: false }).where(eq(schema.tenants.id, TENANT_ID));
    }

    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    const [ship] = await world.db.select().from(schema.logisticsShipments).where(eq(schema.logisticsShipments.id, shipmentId));
    assert(order.status === "delivered" && ship.status === "delivered", `order and shipment delivered (got ${order.status}/${ship.status})`);
    const proofs = await world.db.select().from(schema.deliveryProofs).where(and(eq(schema.deliveryProofs.orderId, orderId), eq(schema.deliveryProofs.capturedVia, "rider_link")));
    assert(proofs.length === 1, `the photo is stored as the proof (got ${proofs.length})`);
    const again = await anon.rider.view({ token });
    assert(again.delivered === true, "opening the link again shows it's delivered");
  },
};
