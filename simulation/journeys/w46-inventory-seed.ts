// === W46 inventory-depth ===
/**
 * w46-inventory-seed.ts — shared seeds for J412–J416. NOT a journey itself
 * (the runner imports journeys explicitly).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, type World } from "../world";

/** Bare product row (stock starts at 0 unless overridden). */
export async function seedProduct(
  world: World,
  tag: string,
  opts: { stock?: number; barcode?: string } = {},
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const productId = `prod-w46-${tag}`;
  await world.db.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-W46-${tag.toUpperCase()}`,
    name: `W46 Product ${tag}`,
    price: "1200.00",
    currency: "NGN",
    status: "active",
    stockQuantity: opts.stock ?? 0,
    barcode: opts.barcode ?? null,
  });
  return productId;
}

/** Warehouse row; returns id. */
export async function seedWarehouse(
  world: World,
  tag: string,
  opts: { isDefault?: boolean } = {},
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const id = `wh-w46-${tag}`;
  await world.db.delete(schema.warehouseStock).where(eq(schema.warehouseStock.warehouseId, id)).catch(() => undefined);
  await world.db.delete(schema.warehouses).where(eq(schema.warehouses.id, id)).catch(() => undefined);
  await world.db.insert(schema.warehouses).values({
    id,
    tenantId: TENANT_ID,
    name: `W46 Warehouse ${tag}`,
    isDefault: opts.isDefault ?? false,
  });
  return id;
}

/** warehouse_stock row; returns id. */
export async function seedWarehouseStock(
  world: World,
  tag: string,
  warehouseId: string,
  productId: string,
  qty: number,
  variantId = "",
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const id = `ws-w46-${tag}`;
  await world.db.delete(schema.warehouseStock).where(eq(schema.warehouseStock.id, id)).catch(() => undefined);
  await world.db.insert(schema.warehouseStock).values({
    id,
    tenantId: TENANT_ID,
    warehouseId,
    productId,
    variantId,
    qty,
  });
  return id;
}
// === END W46 inventory-depth ===
