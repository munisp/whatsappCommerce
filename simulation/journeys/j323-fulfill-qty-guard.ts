/**
 * === W43 fulfillment (Coder A) ===
 * J323 — Over-fulfillment guard: fulfilling more than ordered-minus-already-
 * fulfilled is rejected (CONFLICT) and consumes NO stock reservation; the
 * claim-first FOR UPDATE lock on the order lines is what serializes racing
 * fulfill attempts.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedFulfillOrder } from "./w43-fulfillment-seed";

export const journey: Journey = {
  id: "J323",
  name: "over-fulfillment rejected by claim-first qty guard",
  feature: "fulfill qty guard (ordered - fulfilled)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { fulfillOrderLines } = await import("../../server/services/orderFulfill");
    const phone = world.newPhone("j323");
    const seed = await seedFulfillOrder(world, "j323", phone, [{ qty: 3, stock: 10 }]);
    const line = seed.lines[0];

    // 1. Fulfill more than ordered → CONFLICT, nothing written.
    let code = "";
    try {
      await fulfillOrderLines(world.db, {
        tenantId: TENANT_ID,
        orderId: seed.orderId,
        lines: [{ orderLineId: line.orderLineId, qty: 4 }],
        notify: async () => {},
      });
    } catch (e: any) { code = e?.code; }
    assert(code === "CONFLICT", `over-fulfill rejected with CONFLICT (got ${code})`);

    // 2. Fulfill 2 (ok), then 2 more → CONFLICT (only 1 remaining).
    await fulfillOrderLines(world.db, {
      tenantId: TENANT_ID,
      orderId: seed.orderId,
      lines: [{ orderLineId: line.orderLineId, qty: 2 }],
      notify: async () => {},
    });
    code = "";
    try {
      await fulfillOrderLines(world.db, {
        tenantId: TENANT_ID,
        orderId: seed.orderId,
        lines: [{ orderLineId: line.orderLineId, qty: 2 }],
        notify: async () => {},
      });
    } catch (e: any) { code = e?.code; }
    assert(code === "CONFLICT", `second over-fulfill rejected (got ${code})`);

    // 3. Reservation reflects exactly the one successful fulfill (3→1),
    //    and no failed attempt left fulfillment rows behind.
    const [res] = await world.db.select().from(schema.inventoryReservations)
      .where(and(eq(schema.inventoryReservations.orderId, seed.orderId), eq(schema.inventoryReservations.productId, line.productId)));
    assert(res.status === "committed" && res.qty === 1, `reservation 3→1 exactly once (got ${res.status}/${res.qty})`);
    const fulfillments = await world.db.select().from(schema.orderFulfillments)
      .where(eq(schema.orderFulfillments.orderId, seed.orderId));
    assert(fulfillments.length === 1, `exactly 1 fulfillment row (got ${fulfillments.length})`);

    // 4. Cross-tenant fulfill is invisible (tenant scoping).
    code = "";
    try {
      await fulfillOrderLines(world.db, {
        tenantId: "some-other-tenant",
        orderId: seed.orderId,
        lines: [{ orderLineId: line.orderLineId, qty: 1 }],
        notify: async () => {},
      });
    } catch (e: any) { code = e?.code; }
    assert(code === "NOT_FOUND", `cross-tenant fulfill NOT_FOUND (got ${code})`);
  },
};
