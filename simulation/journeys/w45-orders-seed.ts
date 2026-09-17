// === W45 orders-p0 (Coder C) ===
/**
 * w45-orders-seed.ts — shared seeds for the W45 orders-p0 journeys
 * (J377–J381). NOT a journey itself (runner imports journeys explicitly).
 */
import { TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";

export interface SeededOrder { orderId: string; productId: string }

/** Order + one item + (optionally) an inventory snapshot for restock math. */
export async function seedOrderWithItem(
  world: World,
  tag: string,
  phone: string,
  opts: { status?: string; paymentStatus?: string; qty?: number; unitPrice?: string; stock?: number } = {},
): Promise<SeededOrder> {
  const schema = await import("../../drizzle/schema");
  const qty = opts.qty ?? 2;
  const productId = `prod-w45-${tag}`;
  await world.db.execute(`DELETE FROM inventory_snapshots WHERE "productId" = '${productId}'`).catch(() => undefined);
  await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-W45-${tag.toUpperCase()}`,
    name: `W45 Product ${tag}`,
    price: opts.unitPrice ?? "5000.00",
    currency: "NGN",
    status: "active",
    stockQuantity: opts.stock ?? 5,
    weightKg: "2.500",
  });
  const orderId = `ord-w45-${tag}-${Date.now().toString(36)}`;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber: `W45-${tag.toUpperCase()}`,
    status: opts.status ?? "shipped",
    totalAmount: (Number(opts.unitPrice ?? "5000") * qty).toFixed(2),
    currency: "NGN",
    paymentStatus: opts.paymentStatus ?? "completed",
    metadata: {},
  });
  await world.db.insert(schema.orderItems).values({
    id: crypto.randomUUID(),
    orderId,
    productId,
    productName: `W45 Product ${tag}`,
    quantity: qty,
    unitPrice: opts.unitPrice ?? "5000.00",
    currency: "NGN",
  });
  return { orderId, productId };
}

/** Escrow row in escrow_held with a buyerConfirmDeadline. */
export async function seedEscrow(
  world: World,
  tag: string,
  orderId: string,
  opts: { state?: string; deadline?: Date | null; amount?: string } = {},
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const id = `esc-w45-${tag}-${Date.now().toString(36)}`;
  await world.db.insert(schema.escrowTransactions).values({
    id,
    orderId,
    tenantId: TENANT_ID,
    amount: opts.amount ?? "10000.00",
    platformFee: "0",
    netMerchantAmount: opts.amount ?? "10000.00",
    currency: "NGN",
    custodyMode: "pssp",
    state: opts.state ?? "escrow_held",
    buyerConfirmDeadline: opts.deadline === undefined ? new Date(Date.now() + 3600_000) : opts.deadline,
    idempotencyKey: `w45-${tag}-${orderId}`,
    metadata: {},
  });
  return id;
}

/** Shipment row linked to order + escrow. */
export async function seedShipment(
  world: World,
  tag: string,
  orderId: string,
  escrowTxId: string | null,
  status: string = "out_for_delivery",
): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const id = `shp-w45-${tag}-${Date.now().toString(36)}`;
  await world.db.insert(schema.logisticsShipments).values({
    id,
    orderId,
    tenantId: TENANT_ID,
    escrowTxId,
    provider: "manual",
    status: status as any,
    recipientName: "W45 Buyer",
    recipientPhone: "2348000000000",
    webhookPayloads: [],
    metadata: {},
  });
  return id;
}

/** Purchase order + one item whose productRef = the seeded product's sku. */
export async function seedPoWithItem(
  world: World,
  tag: string,
  opts: { status?: string; qty?: number; unitPriceCents?: number; productRef?: string | null } = {},
): Promise<{ poId: string; poItemId: string; productId: string }> {
  const schema = await import("../../drizzle/schema");
  const qty = opts.qty ?? 4;
  const unit = opts.unitPriceCents ?? 250_000;
  const productId = `prod-w45-po-${tag}`;
  await world.db.execute(`DELETE FROM inventory_snapshots WHERE "productId" = '${productId}'`).catch(() => undefined);
  await world.db.execute(`DELETE FROM products WHERE id = '${productId}'`).catch(() => undefined);
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-W45-PO-${tag.toUpperCase()}`,
    name: `W45 PO Product ${tag}`,
    price: (unit / 100).toFixed(2),
    currency: "NGN",
    status: "active",
    stockQuantity: 1,
  });
  const poId = crypto.randomUUID();
  await world.db.insert(schema.purchaseOrders).values({
    id: poId,
    poNumber: `PO-W45-${tag.toUpperCase()}`,
    buyerTenantId: TENANT_ID,
    supplierTenantId: SUPPLIER_TENANT_ID,
    status: opts.status ?? "paid",
    subtotalCents: qty * unit,
    paymentMode: "paynow",
  });
  const poItemId = crypto.randomUUID();
  await world.db.insert(schema.poItems).values({
    id: poItemId,
    poId,
    productRef: opts.productRef === undefined ? `SIM-W45-PO-${tag.toUpperCase()}` : opts.productRef,
    name: `W45 PO Product ${tag}`,
    qty,
    unitPriceCents: unit,
    lineTotalCents: qty * unit,
  });
  return { poId, poItemId, productId };
}
// === END W45 orders-p0 ===
