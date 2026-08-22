/**
 * J104 — C1 stakeholder journey: a customer browses the catalog over
 * WhatsApp → adds to cart → checks out → pays (real paystack webhook) →
 * order confirmed (receipt + tracking link) → merchant ships it → delivery
 * status updates stream back into the chat → the public tracking view
 * reflects every stage (PII-scrubbed).
 *
 * Exercises end-to-end (REAL services): waMenu showMenu → NLP cart pipeline
 * (reserveStock) → nlp checkout → paymentConfirm → orderCrud.updateStatus
 * notifications → logistics.createShipment → logistics.simulateDelivery
 * buyer pushes → tracking.getByToken shipment history.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller } from "./helpers";
import { generateTrackingToken } from "../../server/services/trackingToken";

export const journey: Journey = {
  id: "J104",
  name: "catalog → cart → checkout → payment → delivery → tracking",
  feature: "C1 customer purchase lifecycle end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("c1");
    await world.grantConsent(phone);

    // ── 1. Browse the catalog via the WhatsApp menu ──────────────────────
    await world.text(phone, "menu");
    assert(world.outbound.lastOfType("interactive", phone), "catalog menu rendered interactively");
    // The shop use case forwards an empty selection as "I want to place an
    // order" into the NLP pipeline — script that canonical key.
    world.llm.when("I want to place an order", {
      reply: "Great — tell me what you want, e.g. '2 Jollof Rice'.",
      intent: "browse",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "1"); // numeric selection 1 = Shop products
    const shopReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(shopReply, "Jollof Rice", "shop flow lists catalog products");

    // ── 2. Add to cart → checkout → delivery address ─────────────────────
    const order = await createChatOrderViaNlp(world, phone, {
      items: [
        { product: "Jollof Rice", quantity: 2 },
        { product: "Grilled Chicken", quantity: 1 },
      ],
      addText: "j104 add to cart",
      confirmText: "j104 checkout",
      fulfillment: "delivery",
      address: "12 Marina Road, Lagos",
    });
    assert(order.total === 9500, `order total ₦8,000 + ₦1,500 delivery fee (got ${order.total})`);
    assert(order.paymentRef, "payment reference issued at checkout");
    const [orderRow] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(orderRow.status === "pending" && ["unpaid", "initiated"].includes(orderRow.paymentStatus),
      `order pending/unpaid-initiated before payment (got ${orderRow.status}/${orderRow.paymentStatus})`);

    // ── 3. Pay: real paystack webhook confirms the order ─────────────────
    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
    await world.waitFor(async () => {
      const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
      return o?.status === "confirmed";
    }, 10000, "order confirmed after payment");
    const [paid] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(paid.paymentStatus === "completed", "paymentStatus completed");
    const receipt = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(receipt, "Payment Receipt", "receipt delivered to the buyer");
    assertIncludes(receipt, "/track/", "receipt carries the tracking link");

    // ── 4. Merchant progresses the order; buyer gets status pushes ───────
    const merchant = await tenantCaller(TENANT_ID, { userId: 1040 });
    // Wave 26 (F12): orderCrud enforces a legal state machine — confirmed
    // must pass through processing before shipped.
    const processing = await merchant.orderCrud.updateStatus({ orderId: order.orderId, status: "processing" });
    assert(processing.ok === true, "merchant moves the order to processing");
    const shipped = await merchant.orderCrud.updateStatus({ orderId: order.orderId, status: "shipped" });
    assert(shipped.ok === true, "merchant marks the order shipped");
    await world.settle(300);
    const shippedPush = world.outbound.findByBody("shipped", phone).pop() ?? world.outbound.findByBody("on the way", phone).pop();
    assert(shippedPush, "buyer received a shipped WhatsApp notification");

    // ── 5. Delivery status updates via the logistics pipeline ────────────
    const shipment = await merchant.logistics.createShipment({
      orderId: order.orderId,
      tenantId: TENANT_ID,
      senderName: "Sim Store",
      senderPhone: "2347000000000",
      senderAddress: { street: "1 Warehouse Rd", city: "Lagos", state: "Lagos" },
      recipientName: "C1 Customer",
      recipientPhone: phone,
      recipientAddress: { street: "12 Marina Road", city: "Lagos", state: "Lagos" },
    });
    assert(shipment?.id, "shipment created for the order");

    for (const status of ["picked_up", "in_transit", "out_for_delivery"] as const) {
      const updated = await merchant.logistics.simulateDelivery({ shipmentId: shipment.id, status });
      assert(updated.status === status, `shipment → ${status}`);
    }
    await world.settle(400);
    const oodPush = world.outbound.findByBody("out for delivery", phone).pop();
    assert(oodPush, "buyer received an out-for-delivery push");

    // The shipment carries a delivery PIN — the buyer hands it over at the door.
    assert(shipment.deliveryPin, "delivery PIN issued at shipment creation");
    const deliveredShipment = await merchant.logistics.simulateDelivery({
      shipmentId: shipment.id, status: "delivered", pin: shipment.deliveryPin,
    });
    assert(deliveredShipment.status === "delivered" && deliveredShipment.deliveredAt, "shipment delivered with timestamp");
    await world.settle(400);
    const deliveredPush = world.outbound.findByBody("has been delivered", phone).pop();
    assert(deliveredPush, "buyer received the delivered push");

    // ── 6. Tracking: public token view reflects the full pipeline ────────
    const token = generateTrackingToken(order.orderId);
    const { appRouter } = await import("../../server/routers");
    const anon = appRouter.createCaller({ user: null, req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} } } as any);
    const view = await anon.tracking.getByToken({ token });
    assert(view.orderNumber === order.orderNumber, "tracking view returns the order number");
    assert(view.paymentStatus === "completed", "tracking view shows payment completed");
    const shipmentView = (view as any).shipment;
    assert(shipmentView?.status === "delivered", `tracking view shows the delivered shipment (got ${JSON.stringify(shipmentView?.status)})`);
    const history = (shipmentView?.history ?? []) as Array<{ status: string }>;
    const stages = history.map((h) => h.status);
    for (const s of ["picked_up", "in_transit", "out_for_delivery", "delivered"]) {
      assert(stages.includes(s), `tracking history includes ${s} (got ${JSON.stringify(stages)})`);
    }
    const serialized = JSON.stringify(view);
    assert(!serialized.includes(phone), "tracking payload contains no buyer phone");
    assert(!/Marina Road/.test(serialized), "tracking payload contains no address");
  },
};
