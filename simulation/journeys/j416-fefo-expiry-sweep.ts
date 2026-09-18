// === W46 inventory-depth ===
/**
 * J416 — ORD-21: inventory_batches + FEFO reserve + expiry sweep alert.
 * Batch receipt credits product + default warehouse stock (audited);
 * reserve picks the EARLIEST-expiry batch first and skips expired batches;
 * release restores batches; the expiry sweep reports expired/expiring
 * batches per tenant and attempts an admin alert.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedProduct } from "./w46-inventory-seed";

export const journey: Journey = {
  id: "J416",
  name: "FEFO batch reserve + expiry sweep alert",
  feature: "ORD-21 inventory_batches FEFO + expiry sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { appRouter } = await import("../../server/routers");
    const { reserveStock, releaseReservations, InsufficientStockError } = await import("../../server/services/inventory");
    const { sweepExpiringBatches } = await import("../../server/services/inventoryDepth");
    const caller = appRouter.createCaller({
      user: { id: 0, role: "user", tenantId: TENANT_ID, name: "j416" },
    } as any);
    const now = Date.now();

    const productId = await seedProduct(world, "j416", { stock: 0 });
    // Expired batch (never allocated), near-expiry batch (FEFO first),
    // later batch (FEFO second).
    await caller.inventoryDepth.receiveBatch({
      tenantId: TENANT_ID, productId, qty: 3, batchCode: "OLD", expiryDate: new Date(now - 24 * 3600_000),
    });
    const bNear = await caller.inventoryDepth.receiveBatch({
      tenantId: TENANT_ID, productId, qty: 4, batchCode: "NEAR", expiryDate: new Date(now + 2 * 24 * 3600_000),
    });
    const bFar = await caller.inventoryDepth.receiveBatch({
      tenantId: TENANT_ID, productId, qty: 4, batchCode: "FAR", expiryDate: new Date(now + 30 * 24 * 3600_000),
    });

    const batchQty = async (id: string) =>
      (await world.db.select().from(schema.inventoryBatches).where(eq(schema.inventoryBatches.id, id)))[0].qty;
    const [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId));
    assert(prod.stockQuantity === 11, `batch receipts credit product stock (got ${prod.stockQuantity})`);
    const whs = await caller.inventoryDepth.listWarehouseStock({ tenantId: TENANT_ID, productId });
    assert(whs.length === 1 && whs[0].qty === 11, "batch receipts credit the default warehouse");

    // FEFO reserve 5: NEAR (4) drained first, then 1 from FAR; expired OLD skipped.
    const orderId = `ord-w46-j416-${Date.now().toString(36)}`;
    await reserveStock(world.db as any, TENANT_ID, orderId, [{ productId, qty: 5 }]);
    assert((await batchQty((await world.db.select().from(schema.inventoryBatches).where(and(eq(schema.inventoryBatches.productId, productId), eq(schema.inventoryBatches.batchCode, "OLD"))))[0].id)) === 3, "expired batch untouched");
    assert((await batchQty((await world.db.select().from(schema.inventoryBatches).where(and(eq(schema.inventoryBatches.productId, productId), eq(schema.inventoryBatches.batchCode, "NEAR"))))[0].id)) === 0, "earliest-expiry batch drained first (FEFO)");
    assert((await batchQty((await world.db.select().from(schema.inventoryBatches).where(and(eq(schema.inventoryBatches.productId, productId), eq(schema.inventoryBatches.batchCode, "FAR"))))[0].id)) === 3, "later batch covers the remainder");
    void bNear; void bFar;

    // FEFO shortage: only 3 unexpired left → reserving 4 fails claim-first.
    let blocked = false;
    try {
      await (world.db as any).transaction(async (tx: any) => {
        await reserveStock(tx, TENANT_ID, `${orderId}-short`, [{ productId, qty: 4 }]);
      });
    } catch (e: any) {
      blocked = e instanceof InsufficientStockError;
    }
    assert(blocked, "unexpired batch shortage fails the reserve");

    // Release restores batches via the audit trail.
    await releaseReservations(world.db as any, orderId);
    assert((await batchQty((await world.db.select().from(schema.inventoryBatches).where(and(eq(schema.inventoryBatches.productId, productId), eq(schema.inventoryBatches.batchCode, "NEAR"))))[0].id)) === 4, "release restores NEAR batch");
    assert((await batchQty((await world.db.select().from(schema.inventoryBatches).where(and(eq(schema.inventoryBatches.productId, productId), eq(schema.inventoryBatches.batchCode, "FAR"))))[0].id)) === 4, "release restores FAR batch");
    const audits = await world.db
      .select()
      .from(schema.stockAdjustments)
      .where(and(eq(schema.stockAdjustments.tenantId, TENANT_ID), eq(schema.stockAdjustments.productId, productId)));
    assert(audits.filter((a) => a.refType === "batch_receipt").length === 3, "batch receipts audited");
    assert(audits.some((a) => a.refType === "batch_reserve" && a.deltaQty === -4), "FEFO claims audited");
    assert(audits.filter((a) => a.refType === "batch_release").length === 2, "batch restores audited");

    // Expiry sweep: OLD is expired (qty 3), NEAR expires within 7 days.
    const sweep = await sweepExpiringBatches(world.db as any);
    assert(sweep.expired >= 1 && sweep.expiring >= 1, `sweep reports expired+expiring (got ${sweep.expired}/${sweep.expiring})`);
    assert(sweep.tenants >= 1, "sweep groups per tenant");
  },
};
// === END W46 inventory-depth ===
