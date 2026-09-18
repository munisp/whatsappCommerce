// === W46 orders-p2 (Coder G) ===
/**
 * w46-orders-seed.ts — shared seeds for the W46 orders-p2 journeys
 * (J417–J421). NOT a journey itself (runner imports journeys explicitly).
 */
import { TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";

/** Supplier profile row with a specific lead time (upsert by tenant PK). */
export async function seedSupplierProfile(
  world: World,
  leadTimeDays: number,
  supplierTenantId: string = SUPPLIER_TENANT_ID,
): Promise<void> {
  await world.pg.query(
    `INSERT INTO supplier_profiles (tenant_id, lead_time_days, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (tenant_id) DO UPDATE SET lead_time_days = $2, status = 'active'`,
    [supplierTenantId, leadTimeDays],
  );
}

/** PO in a given status with a buyer phone for notifications. */
export async function seedPo(
  world: World,
  tag: string,
  opts: { status?: string; buyerPhone?: string | null } = {},
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const poId = crypto.randomUUID();
  await world.db.insert(schema.purchaseOrders).values({
    id: poId,
    poNumber: `PO-W46-${tag.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
    buyerTenantId: TENANT_ID,
    supplierTenantId: SUPPLIER_TENANT_ID,
    status: opts.status ?? "submitted",
    subtotalCents: 100_000,
    paymentMode: "paynow",
    buyerPhone: opts.buyerPhone === undefined ? world.newPhone(`po-${tag}`) : opts.buyerPhone,
  });
  return poId;
}

/** Order + one item for a given product (W46 variant with address control). */
export async function seedOrder(
  world: World,
  tag: string,
  opts: {
    phone?: string;
    productId?: string;
    status?: string;
    paymentStatus?: string;
    qty?: number;
    unitPrice?: string;
    address?: string | null;
    createdAt?: Date;
  } = {},
): Promise<{ orderId: string; productId: string; phone: string }> {
  const schema = await import("../../drizzle/schema");
  const qty = opts.qty ?? 2;
  const unitPrice = opts.unitPrice ?? "5000.00";
  const phone = opts.phone ?? world.newPhone(`ord-${tag}`);
  const productId = opts.productId ?? `prod-w46-${tag}`;
  if (!opts.productId) {
    await world.db.execute(`DELETE FROM inventory_snapshots WHERE "productId" = '${productId}'`).catch(() => undefined);
    await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: productId,
      tenantId: TENANT_ID,
      sku: `SIM-W46-${tag.toUpperCase()}`,
      name: `W46 Product ${tag}`,
      price: unitPrice,
      currency: "NGN",
      status: "active",
      stockQuantity: 50,
      weightKg: "2.500",
    });
  }
  const orderId = `ord-w46-${tag}-${crypto.randomUUID().slice(0, 8)}`;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber: `W46-${tag.toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
    status: opts.status ?? "pending",
    totalAmount: (Number(unitPrice) * qty).toFixed(2),
    currency: "NGN",
    paymentStatus: opts.paymentStatus ?? "unpaid",
    shippingAddress: opts.address !== undefined && opts.address !== null ? { raw: opts.address } : null,
    metadata: {},
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  await world.db.insert(schema.orderItems).values({
    id: crypto.randomUUID(),
    orderId,
    productId,
    productName: `W46 Product ${tag}`,
    quantity: qty,
    unitPrice,
    currency: "NGN",
  });
  return { orderId, productId, phone };
}
// === END W46 orders-p2 ===
