/**
 * === W38 stock integrity (Coder C, ORD-4 + ORD-1) ===
 * J260 — The updateStatus → cancelled transition uses the SAME unified
 * cancelOrder path as orderCrud.cancel: paid-order stock is restocked
 * exactly once and the inventory_snapshots credit is tenantId-predicated
 * (ORD-2 hygiene). Before W38 this path did no snapshot restock and no
 * committed-reservation release at all.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import { adminCaller } from "./helpers";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J260",
  name: "paid-cancel restocks exactly once (updateStatus path)",
  feature: "ORD-4 unified cancelOrder via updateStatus + ORD-2 tenant predicate",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const inv = await import("../../server/services/inventory");

    const productId = "p-chicken";
    await world.db.update(schema.products).set({ stockQuantity: 50 }).where(eq(schema.products.id, productId));

    // ERP snapshot row for the product — the legacy ledger cancel must credit
    // (with the ORD-2 tenantId predicate: a row for ANOTHER tenant must be
    // untouched even with the same productId).
    const snapId = "w38-j260-snap";
    const otherSnapId = "w38-j260-snap-other";
    // W38 merger fix-forward: the (tenantId, productId) unique index is NOT
    // covered by ON CONFLICT (id); earlier journeys' cancel flows may leave
    // a snapshot row for this product. Clear it for a deterministic seed.
    await world.db.execute(
      `DELETE FROM inventory_snapshots WHERE "tenantId" IN ('${TENANT_ID}', 'sim-supplier') AND "productId" = '${productId}'`,
    );
    await world.db.execute(
      `INSERT INTO inventory_snapshots (id, "tenantId", "productId", "stockQty", "reservedQty", "availableQty")
       VALUES ('${snapId}', '${TENANT_ID}', '${productId}', 50, 2, 48)
       ON CONFLICT (id) DO NOTHING`,
    );
    await world.db.execute(
      `INSERT INTO inventory_snapshots (id, "tenantId", "productId", "stockQty", "reservedQty", "availableQty")
       VALUES ('${otherSnapId}', 'sim-supplier', '${productId}', 10, 0, 10)
       ON CONFLICT (id) DO NOTHING`,
    );

    const orderId = "w38-j260-order";
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "cust-w38-j260",
      orderNumber: "SIM-W38-J260",
      status: "confirmed",
      totalAmount: "6000.00",
      currency: "NGN",
      paymentStatus: "completed",
    });
    await world.db.insert(schema.orderItems).values({
      orderId, productId, productName: "Grilled Chicken", quantity: 2, unitPrice: "3000.00",
    });
    await inv.reserveStock(world.db, TENANT_ID, orderId, [{ productId, qty: 2 }]);
    await inv.commitReservations(world.db, orderId);
    let [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 48, `stock 48 after paid commit (got ${prod.stockQuantity})`);

    // Cancel via updateStatus → cancelled (the OTHER router path).
    const caller = await adminCaller();
    const res = await caller.orderCrud.updateStatus({ orderId, status: "cancelled", notes: "ops cancel" });
    assert(res.ok === true, "updateStatus cancel succeeded");

    [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 50, `updateStatus path restocked paid order to 50 (got ${prod.stockQuantity})`);

    const rows = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, orderId));
    assert(rows.length === 1 && rows[0].status === "released", "committed reservation released via updateStatus path");

    // Snapshot credited for THIS tenant only (ORD-2 predicate).
    const snapRaw = await world.pg.query(`SELECT "availableQty", "reservedQty" FROM inventory_snapshots WHERE id = $1`, [snapId]);
    const snapRows = (snapRaw as any).rows ?? snapRaw;
    const avail = Number(snapRows[0].availableQty);
    const reserved = Number(snapRows[0].reservedQty);
    assert(avail === 50 && reserved === 0, `snapshot credited 48→50 / 2→0 (got ${avail}/${reserved})`);
    const otherRaw = await world.pg.query(`SELECT "availableQty" FROM inventory_snapshots WHERE id = $1`, [otherSnapId]);
    const otherRows = (otherRaw as any).rows ?? otherRaw;
    assert(Number(otherRows[0].availableQty) === 10, "other-tenant snapshot row untouched (ORD-2 predicate)");

    // Exactly-once through the router too: a repeated transition is illegal.
    let threw = false;
    try {
      await caller.orderCrud.updateStatus({ orderId, status: "cancelled" });
    } catch { threw = true; }
    assert(threw, "repeated cancel transition rejected (terminal state)");
    await world.settle(200); // let fire-and-forget notification/low-stock work quiesce
    [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod && prod.stockQuantity === 50, `stock still 50 after repeated attempt (got ${prod?.stockQuantity})`);
  },
};
