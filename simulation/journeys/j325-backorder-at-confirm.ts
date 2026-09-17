/**
 * === W43 fulfillment (Coder A) ===
 * J325 — Backorder at confirm: with tenants.allowBackorders = true, checkout
 * succeeds despite insufficient stock — the short line is marked
 * 'backordered' and an open backorder_requests row records the demand. With
 * the flag off (default), the same checkout still fails closed
 * (PRECONDITION_FAILED) — current behavior unchanged.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";
import { setAllowBackorders } from "./w43-fulfillment-seed";

export const journey: Journey = {
  id: "J325",
  name: "backorder at confirm instead of blocking checkout",
  feature: "tenants.allowBackorders + order line backordered + backorder_requests",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const phone = world.newPhone("j325");
    const productId = `p-w43-j325-${randomUUID().slice(0, 6)}`;
    await world.db.insert(schema.products).values({
      id: productId,
      tenantId: TENANT_ID,
      sku: `W43-J325-${randomUUID().slice(0, 6)}`,
      name: "W43 Backorder Widget",
      price: "500.00",
      currency: "NGN",
      stockQuantity: 1,
      status: "active",
    } as any);

    // 1. Flag OFF (default): insufficient stock blocks checkout (unchanged).
    await setAllowBackorders(world, false);
    let code = "";
    try {
      await caller.orderCrud.create({
        tenantId: TENANT_ID,
        customerId: phone,
        items: [{ productId, productName: "W43 Backorder Widget", quantity: 3, unitPrice: 500 }],
      });
    } catch (e: any) { code = e?.code; }
    assert(code === "PRECONDITION_FAILED", `flag off blocks checkout (got ${code})`);

    // 2. Flag ON: checkout succeeds; line backordered for the shortfall.
    await setAllowBackorders(world, true);
    try {
      const created = await caller.orderCrud.create({
        tenantId: TENANT_ID,
        customerId: phone,
        items: [{ productId, productName: "W43 Backorder Widget", quantity: 3, unitPrice: 500 }],
      });
      assert(!!created.orderId, "order created despite shortage");

      const lines = await world.db.select().from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, created.orderId));
      assert(lines.length === 1 && lines[0].status === "backordered",
        `line marked backordered (got ${lines[0]?.status})`);

      const requests = await world.db.select().from(schema.backorderRequests)
        .where(eq(schema.backorderRequests.orderLineId, lines[0].id));
      assert(requests.length === 1, `1 open backorder request (got ${requests.length})`);
      assert(requests[0].status === "open" && requests[0].qty === 2,
        `backorder qty 2 open (got ${requests[0].status}/${requests[0].qty})`);
      assert(requests[0].productId === productId && requests[0].tenantId === TENANT_ID,
        "backorder tenant/product scoped");

      // The 1 available unit was reserved claim-first; nothing oversold.
      const [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId));
      assert(prod.stockQuantity === 0, `stock fully claimed (got ${prod.stockQuantity})`);
      const resv = await world.db.select().from(schema.inventoryReservations)
        .where(eq(schema.inventoryReservations.orderId, created.orderId));
      assert(resv.length === 1 && resv[0].status === "reserved" && resv[0].qty === 1,
        `available unit reserved (got ${resv.length}/${resv[0]?.status}/${resv[0]?.qty})`);

      // 3. Fully-backordered line (zero stock) also works: everything queued.
      const created2 = await caller.orderCrud.create({
        tenantId: TENANT_ID,
        customerId: phone,
        items: [{ productId, productName: "W43 Backorder Widget", quantity: 1, unitPrice: 500 }],
      });
      const lines2 = await world.db.select().from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, created2.orderId));
      assert(lines2[0].status === "backordered", "zero-stock line backordered");
      const requests2 = await world.db.select().from(schema.backorderRequests)
        .where(eq(schema.backorderRequests.orderLineId, lines2[0].id));
      assert(requests2.length === 1 && requests2[0].qty === 1, "full shortfall queued");
    } finally {
      await setAllowBackorders(world, false);
    }
  },
};
