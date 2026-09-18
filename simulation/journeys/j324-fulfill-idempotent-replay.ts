/**
 * === W43 fulfillment (Coder A) ===
 * J324 — Idempotent fulfillment replay: the same fulfillmentId replayed
 * returns the original fulfillment and does NOT decrement the committed
 * stock reservation a second time (idempotency key = fulfillmentId +
 * orderLineId, enforced by the ofl_idem_idx unique index).
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedFulfillOrder } from "./w43-fulfillment-seed";

export const journey: Journey = {
  id: "J324",
  name: "fulfillment replay is idempotent (stock consumed exactly once)",
  feature: "fulfillmentId idempotency key",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { fulfillOrderLines } = await import("../../server/services/orderFulfill");
    const phone = world.newPhone("j324");
    const seed = await seedFulfillOrder(world, "j324", phone, [{ qty: 4, stock: 10 }]);
    const line = seed.lines[0];
    const fulfillmentId = randomUUID();
    let notifyCount = 0;
    const notify = async () => { notifyCount++; };

    const r1 = await fulfillOrderLines(world.db, {
      tenantId: TENANT_ID,
      orderId: seed.orderId,
      fulfillmentId,
      lines: [{ orderLineId: line.orderLineId, qty: 3 }],
      notify,
    });
    assert(!r1.replayed && r1.fulfillment.id === fulfillmentId, "first call recorded");

    // Replay with the SAME fulfillmentId (webhook retry / double-click).
    const r2 = await fulfillOrderLines(world.db, {
      tenantId: TENANT_ID,
      orderId: seed.orderId,
      fulfillmentId,
      lines: [{ orderLineId: line.orderLineId, qty: 3 }],
      notify,
    });
    assert(r2.replayed, "replay detected");
    assert(r2.fulfillment.id === r1.fulfillment.id, "same fulfillment returned");

    // Exactly one fulfillment + one line; reservation consumed exactly once.
    const fulfillments = await world.db.select().from(schema.orderFulfillments)
      .where(eq(schema.orderFulfillments.orderId, seed.orderId));
    assert(fulfillments.length === 1, `1 fulfillment (got ${fulfillments.length})`);
    const fLines = await world.db.select().from(schema.orderFulfillmentLines)
      .where(eq(schema.orderFulfillmentLines.fulfillmentId, fulfillmentId));
    assert(fLines.length === 1 && fLines[0].qty === 3, `1 fulfillment line qty 3 (got ${fLines.length})`);
    const [res] = await world.db.select().from(schema.inventoryReservations)
      .where(and(eq(schema.inventoryReservations.orderId, seed.orderId), eq(schema.inventoryReservations.productId, line.productId)));
    assert(res.status === "committed" && res.qty === 1, `reservation 4→1 exactly once (got ${res.status}/${res.qty})`);
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
    assert(order.status === "partially_fulfilled", `order partially_fulfilled (got ${order.status})`);
    assert(notifyCount === 1, `customer notified once (got ${notifyCount})`);
  },
};
