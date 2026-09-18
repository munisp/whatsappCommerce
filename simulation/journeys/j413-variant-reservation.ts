// === W46 inventory-depth ===
/**
 * J413 — ORD-15: claim-first variant reservation. reserveStock with a
 * variantId claims product_variants.stockQuantity atomically (oversell at
 * the variant level throws InsufficientStockError even when the product
 * pool has stock), the reservation row carries variantId, and release
 * restores the variant stock with audit rows.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedProduct } from "./w46-inventory-seed";

export const journey: Journey = {
  id: "J413",
  name: "variant-level claim-first reservation + release restore",
  feature: "ORD-15 variant reservation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { appRouter } = await import("../../server/routers");
    const { reserveStock, releaseReservations, InsufficientStockError } = await import("../../server/services/inventory");
    const caller = appRouter.createCaller({
      user: { id: 0, role: "user", tenantId: TENANT_ID, name: "j413" },
    } as any);

    // Product stock comes ENTIRELY from the variant receipt (initialStock 4).
    const productId = await seedProduct(world, "j413", { stock: 0 });
    const v = await caller.inventoryDepth.upsertVariant({
      tenantId: TENANT_ID,
      productId,
      sku: "SIM-W46-J413-BLU-L",
      name: "Blue / L",
      barcode: "4006381333931",
      initialStock: 4,
    });

    const getLevels = async () => {
      const [p] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId));
      const [vv] = await world.db.select().from(schema.productVariants).where(eq(schema.productVariants.id, v.id));
      return { product: p.stockQuantity, variant: vv.stockQuantity };
    };
    assert((await getLevels()).variant === 4, "variant receipt stocked the variant");

    // Reserve 3 of 4 by variantId — claims BOTH levels atomically.
    const orderId = `ord-w46-j413-${Date.now().toString(36)}`;
    await reserveStock(world.db as any, TENANT_ID, orderId, [{ productId, qty: 3, variantId: v.id }]);
    let lv = await getLevels();
    assert(lv.product === 1 && lv.variant === 1, `reserve decrements product+variant (got ${lv.product}/${lv.variant})`);

    const [res] = await world.db
      .select()
      .from(schema.inventoryReservations)
      .where(and(eq(schema.inventoryReservations.orderId, orderId), eq(schema.inventoryReservations.status, "reserved")));
    assert(res.variantId === v.id, "reservation row carries variantId");

    // Oversell the variant: only 1 left, request 2 → claim-first throw
    // inside a transaction, so the product-level claim rolls back too.
    let blocked = false;
    try {
      await (world.db as any).transaction(async (tx: any) => {
        await reserveStock(tx, TENANT_ID, `${orderId}-b`, [{ productId, qty: 2, variantId: v.id }]);
      });
    } catch (e: any) {
      blocked = e instanceof InsufficientStockError;
    }
    assert(blocked, "variant oversell throws InsufficientStockError");
    lv = await getLevels();
    assert(lv.product === 1 && lv.variant === 1, "failed variant claim rolled back cleanly");

    // Release restores BOTH levels, audited.
    const released = await releaseReservations(world.db as any, orderId);
    assert(released === 1, "one reservation released");
    lv = await getLevels();
    assert(lv.product === 4 && lv.variant === 4, `release restores product+variant (got ${lv.product}/${lv.variant})`);

    const audits = await world.db
      .select()
      .from(schema.stockAdjustments)
      .where(and(eq(schema.stockAdjustments.tenantId, TENANT_ID), eq(schema.stockAdjustments.productId, productId)));
    assert(audits.some((a) => a.refType === "variant_receipt" && a.deltaQty === 4), "variant receipt audited");
    assert(audits.some((a) => a.refType === "variant_release" && a.deltaQty === 3 && a.variantId === v.id), "variant release restore audited");
  },
};
// === END W46 inventory-depth ===
