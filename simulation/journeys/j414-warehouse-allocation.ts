// === W46 inventory-depth ===
/**
 * J414 — ORD-16: warehouse allocation at reserve time. Reserve claims the
 * DEFAULT warehouse first, then the largest-qty warehouse; every claim is
 * audited (warehouse_allocation) and release restores each warehouse
 * exactly (warehouse_release). Warehouse stock that cannot cover the
 * reservation fails the whole reserve claim-first.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedProduct, seedWarehouse, seedWarehouseStock } from "./w46-inventory-seed";

export const journey: Journey = {
  id: "J414",
  name: "warehouse allocation at reserve + release restore",
  feature: "ORD-16 warehouse_stock allocation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { reserveStock, releaseReservations, InsufficientStockError } = await import("../../server/services/inventory");

    const productId = await seedProduct(world, "j414", { stock: 10 });
    const whDefault = await seedWarehouse(world, "j414a", { isDefault: true });
    const whSecond = await seedWarehouse(world, "j414b");
    await seedWarehouseStock(world, "j414a", whDefault, productId, 3);
    await seedWarehouseStock(world, "j414b", whSecond, productId, 7);

    const stockOf = async (whId: string) => {
      const [r] = await world.db
        .select()
        .from(schema.warehouseStock)
        .where(and(eq(schema.warehouseStock.warehouseId, whId), eq(schema.warehouseStock.productId, productId)));
      return r.qty;
    };

    // Reserve 5: default (3) drained first, remaining 2 from second.
    const orderId = `ord-w46-j414-${Date.now().toString(36)}`;
    await reserveStock(world.db as any, TENANT_ID, orderId, [{ productId, qty: 5 }]);
    assert((await stockOf(whDefault)) === 0, "default warehouse drained first");
    assert((await stockOf(whSecond)) === 5, "remainder allocated from second warehouse");

    const allocs = await world.db
      .select()
      .from(schema.stockAdjustments)
      .where(and(eq(schema.stockAdjustments.tenantId, TENANT_ID), eq(schema.stockAdjustments.refType, "warehouse_allocation")));
    const mine = allocs.filter((a) => a.productId === productId && a.deltaQty < 0);
    assert(mine.length === 2, `two warehouse allocation audit rows (got ${mine.length})`);
    assert(mine.reduce((s, a) => s + a.deltaQty, 0) === -5, "allocations sum to the reserved qty");

    // Release restores each warehouse exactly.
    await releaseReservations(world.db as any, orderId);
    assert((await stockOf(whDefault)) === 3, "default warehouse restored");
    assert((await stockOf(whSecond)) === 7, "second warehouse restored");
    const restores = await world.db
      .select()
      .from(schema.stockAdjustments)
      .where(and(eq(schema.stockAdjustments.tenantId, TENANT_ID), eq(schema.stockAdjustments.refType, "warehouse_release")));
    assert(restores.filter((a) => a.productId === productId).length === 2, "warehouse restores audited");

    // Warehouse pool (5 total) smaller than the reserve (6) → claim-first
    // failure even though products.stockQuantity (10) could cover it.
    const pid2 = await seedProduct(world, "j414x", { stock: 10 });
    await seedWarehouseStock(world, "j414xa", whDefault, pid2, 5);
    let blocked = false;
    try {
      await (world.db as any).transaction(async (tx: any) => {
        await reserveStock(tx, TENANT_ID, `${orderId}-short`, [{ productId: pid2, qty: 6 }]);
      });
    } catch (e: any) {
      blocked = e instanceof InsufficientStockError;
    }
    assert(blocked, "warehouse shortage fails the reserve claim-first");
    assert((await world.db.select().from(schema.products).where(eq(schema.products.id, pid2)))[0].stockQuantity === 10, "failed reserve rolled back product stock");
  },
};
// === END W46 inventory-depth ===
