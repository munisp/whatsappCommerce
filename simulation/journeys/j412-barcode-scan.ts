// === W46 inventory-depth ===
/**
 * J412 — ORD-15: products.barcode + scan endpoint + variant stock rows.
 * A product barcode scan resolves the product; a variant barcode resolves
 * the variant WITH its parent product; an unknown barcode is NOT_FOUND;
 * another tenant cannot see the barcode.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedProduct } from "./w46-inventory-seed";

export const journey: Journey = {
  id: "J412",
  name: "barcode scan endpoint resolves product + variant",
  feature: "ORD-15 barcode scan",
  async run(world: World) {
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: { id: 0, role: "user", tenantId: TENANT_ID, name: "j412" },
    } as any);
    const stranger = appRouter.createCaller({
      user: { id: 1, role: "user", tenantId: "tenant-stranger-j412", name: "j412x" },
    } as any);

    const productId = await seedProduct(world, "j412", { barcode: "5901234123457" });
    const v = await caller.inventoryDepth.upsertVariant({
      tenantId: TENANT_ID,
      productId,
      sku: "SIM-W46-J412-RED-M",
      name: "Red / M",
      attributes: { colour: "red", size: "M" },
      barcode: "5901234123458",
    });
    assert(v.id, "variant created");

    // Product barcode → product hit.
    const hitP = await caller.inventoryDepth.scanBarcode({ tenantId: TENANT_ID, barcode: "5901234123457" });
    assert(hitP.product?.id === productId, "product barcode resolves product");
    assert(!hitP.variant, "product barcode does not invent a variant");

    // Variant barcode → variant + parent product.
    const hitV = await caller.inventoryDepth.scanBarcode({ tenantId: TENANT_ID, barcode: "5901234123458" });
    assert(hitV.variant?.id === v.id, "variant barcode resolves variant");
    assert(hitV.product?.id === productId, "variant scan carries the parent product");

    // Unknown barcode → NOT_FOUND.
    let missing = false;
    try {
      await caller.inventoryDepth.scanBarcode({ tenantId: TENANT_ID, barcode: "0000000000000" });
    } catch (e: any) {
      missing = e?.code === "NOT_FOUND";
    }
    assert(missing, "unknown barcode is NOT_FOUND");

    // Tenant scoping: another tenant cannot scan our barcode.
    let scoped = false;
    try {
      await stranger.inventoryDepth.scanBarcode({ tenantId: "tenant-stranger-j412", barcode: "5901234123457" });
    } catch (e: any) {
      scoped = e?.code === "NOT_FOUND";
    }
    assert(scoped, "barcode is tenant-scoped");

    // Variant listing is tenant-scoped and complete.
    const variants = await caller.inventoryDepth.listVariants({ tenantId: TENANT_ID, productId });
    assert(variants.length === 1 && variants[0].sku === "SIM-W46-J412-RED-M", "listVariants returns the seeded variant");
  },
};
// === END W46 inventory-depth ===
