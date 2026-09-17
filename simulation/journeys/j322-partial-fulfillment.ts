/**
 * === W43 fulfillment (Coder A) ===
 * J322 — Partial fulfillment happy path: fulfilling a SUBSET of order lines
 * creates order_fulfillments/order_fulfillment_lines rows, consumes the
 * committed stock reservation (decremented, never restocked), and derives
 * orders.status = 'partially_fulfilled'; completing every line derives
 * 'shipped' and flips fully-consumed reservations to 'fulfilled'.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedFulfillOrder } from "./w43-fulfillment-seed";

export const journey: Journey = {
  id: "J322",
  name: "partial fulfillment derives partially_fulfilled then shipped",
  feature: "order_fulfillments + reservation consumption + status derivation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { fulfillOrderLines } = await import("../../server/services/orderFulfill");
    const phone = world.newPhone("j322");
    const seed = await seedFulfillOrder(world, "j322", phone, [
      { qty: 2, stock: 10 },
      { qty: 3, stock: 8 },
    ]);
    const notified: { category: string; text: string }[] = [];
    const notify = async (_t: string, _ref: string, category: string, text: string) => {
      notified.push({ category, text });
    };

    // 1. Fulfill 1 unit of line A and 1 of line B (both partial).
    const r1 = await fulfillOrderLines(world.db, {
      tenantId: TENANT_ID,
      orderId: seed.orderId,
      lines: [
        { orderLineId: seed.lines[0].orderLineId, qty: 1 },
        { orderLineId: seed.lines[1].orderLineId, qty: 1 },
      ],
      trackingCarrier: "GIGL",
      trackingNumber: "TRK-322",
      notify,
    });
    assert(!r1.replayed, "first fulfill is not a replay");
    assert(r1.fulfillment.status === "partial", `fulfillment partial (got ${r1.fulfillment.status})`);
    assert(r1.orderStatus === "partially_fulfilled", `order partially_fulfilled (got ${r1.orderStatus})`);

    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
    assert(order.status === "partially_fulfilled", `db order status partially_fulfilled (got ${order.status})`);

    const fLines = await world.db.select().from(schema.orderFulfillmentLines)
      .where(eq(schema.orderFulfillmentLines.fulfillmentId, r1.fulfillment.id));
    assert(fLines.length === 2, `2 fulfillment lines (got ${fLines.length})`);

    // Committed reservations consumed: 2→1 on line A, 3→2 on line B.
    const resA = (await world.db.select().from(schema.inventoryReservations)
      .where(and(eq(schema.inventoryReservations.orderId, seed.orderId), eq(schema.inventoryReservations.productId, seed.lines[0].productId))))[0];
    assert(resA.status === "committed" && resA.qty === 1, `reservation A consumed 2→1 (got ${resA.status}/${resA.qty})`);

    // products.stockQuantity NOT restocked by fulfillment (goods left).
    const [prodA] = await world.db.select().from(schema.products).where(eq(schema.products.id, seed.lines[0].productId));
    assert(prodA.stockQuantity === 8, `stock stays decremented (got ${prodA.stockQuantity})`);

    // 2. Fulfill the remainder → complete → order 'shipped'.
    const r2 = await fulfillOrderLines(world.db, {
      tenantId: TENANT_ID,
      orderId: seed.orderId,
      lines: [
        { orderLineId: seed.lines[0].orderLineId, qty: 1 },
        { orderLineId: seed.lines[1].orderLineId, qty: 2 },
      ],
      notify,
    });
    assert(r2.fulfillment.status === "complete", `fulfillment complete (got ${r2.fulfillment.status})`);
    assert(r2.orderStatus === "shipped", `order shipped (got ${r2.orderStatus})`);
    const resA2 = (await world.db.select().from(schema.inventoryReservations)
      .where(and(eq(schema.inventoryReservations.orderId, seed.orderId), eq(schema.inventoryReservations.productId, seed.lines[0].productId))))[0];
    assert(resA2.status === "fulfilled", `reservation A fully consumed (got ${resA2.status})`);

    // 3. Customer notified on the parity-registered category.
    assert(notified.length === 2 && notified.every((n) => n.category === "partial_fulfillment"),
      `partial_fulfillment notifications sent (got ${notified.map((n) => n.category).join(",")})`);
    const parity = await import("../../server/services/channelParity");
    const cat = parity.getParityCategory("partial_fulfillment");
    assert(!!cat && cat.telegram === "full", "partial_fulfillment registered for BOTH channels");
  },
};
