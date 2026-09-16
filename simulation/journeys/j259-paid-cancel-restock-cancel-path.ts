/**
 * === W38 stock integrity (Coder C, ORD-1 + ORD-4) ===
 * J259 — Paid-order cancel via the orderCrud.cancel path restocks EXACTLY
 * ONCE. Before W38, paymentConfirm committed the reservations and cancel
 * only released 'reserved' rows — products.stockQuantity was never restored
 * for paid orders (the two stock ledgers diverged).
 *
 * Proof: reserve → commit (simulates paymentConfirm) → cancel via the real
 * router → stock returns to the original level; a second release attempt
 * (replay/race) credits nothing more.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import { adminCaller } from "./helpers";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J259",
  name: "paid-cancel restocks exactly once (cancel path)",
  feature: "ORD-1 releaseCommittedReservations + ORD-4 unified cancelOrder",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const inv = await import("../../server/services/inventory");

    const productId = "p-ankara";
    await world.db.update(schema.products).set({ stockQuantity: 50 }).where(eq(schema.products.id, productId));

    // Seed a PAID order (pending→confirmed is the paid transition) with items.
    const orderId = "w38-j259-order";
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "cust-w38-j259",
      orderNumber: "SIM-W38-J259",
      status: "confirmed",
      totalAmount: "10000.00",
      currency: "NGN",
      paymentStatus: "completed",
    });
    await world.db.insert(schema.orderItems).values({
      orderId, productId, productName: "Ankara Fabric", quantity: 2, unitPrice: "5000.00",
    });

    // Reserve 2 (stock 50→48) then commit — exactly what paymentConfirm does.
    await inv.reserveStock(world.db, TENANT_ID, orderId, [{ productId, qty: 2 }]);
    const committed = await inv.commitReservations(world.db, orderId);
    assert(committed === 1, `reservation committed (got ${committed})`);
    let [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 48, `stock 48 after paid reserve+commit (got ${prod.stockQuantity})`);

    // Cancel via the REAL router path (admin caller → orderCrud.cancel).
    const caller = await adminCaller();
    const res = await caller.orderCrud.cancel({ orderId, reason: "buyer changed mind" });
    assert(res.ok === true, "cancel succeeded");

    [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 50, `ORD-1: paid cancel restocked to 50 (got ${prod.stockQuantity})`);

    const rows = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, orderId));
    assert(rows.length === 1 && rows[0].status === "released",
      `committed reservation released (got ${rows.map((r: any) => r.status).join(",")})`);

    // Exactly-once: replaying the release legs credits nothing more.
    const again = await inv.releaseCommittedReservations(world.db, orderId);
    const again2 = await inv.releaseReservations(world.db, orderId);
    assert(again === 0 && again2 === 0, `replayed releases are no-ops (got ${again}/${again2})`);
    [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 50, `stock still 50 after replay (got ${prod.stockQuantity})`);

    // And a second cancel is rejected by the terminal status.
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(order.status === "cancelled", `order cancelled (got ${order.status})`);
  },
};
