/**
 * === W43 exchanges (Coder B) ===
 * w43-exchange-seed.ts — shared seed for the W43 exchange/audit journeys
 * (J327–J331). NOT a journey itself (runner imports journeys explicitly).
 *
 * Creates per-journey products (isolated stock so journeys never race the
 * shared catalog) plus a delivered order with ONE order line, and an
 * inventory_snapshots row for the origin product.
 */
import { randomUUID } from "node:crypto";
import { TENANT_ID, type World } from "../world";

export interface ExchangeSeed {
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  /** Origin product (on the order line): price 2000.00, stock 20. */
  fromProductId: string;
  /** Replacement product: price 3500.00, stock 10 (positive delta swap). */
  toProductId: string;
  /** Cheaper product: price 500.00, stock 10 (negative delta swap). */
  cheapProductId: string;
  /** Zero-stock product (insufficient-stock receive test). */
  emptyProductId: string;
  phone: string;
  lineQty: number;
}

export async function seedExchangeOrder(world: World, tag: string, phone: string): Promise<ExchangeSeed> {
  const schema = await import("../../drizzle/schema");
  const uniq = randomUUID().slice(0, 8);
  const fromProductId = `p-w43-${tag}-from-${uniq}`;
  const toProductId = `p-w43-${tag}-to-${uniq}`;
  const cheapProductId = `p-w43-${tag}-cheap-${uniq}`;
  const emptyProductId = `p-w43-${tag}-empty-${uniq}`;

  const mk = (id: string, sku: string, name: string, price: string, stock: number) =>
    world.db.insert(schema.products).values({
      id, tenantId: TENANT_ID, sku, name, description: `${name} — W43 sim`, category: "sim",
      price, currency: "NGN", status: "active", stockQuantity: stock, lowStockThreshold: 1,
    });
  await mk(fromProductId, `W43-${tag}-FROM-${uniq}`, "W43 Origin Widget", "2000.00", 20);
  await mk(toProductId, `W43-${tag}-TO-${uniq}`, "W43 Deluxe Widget", "3500.00", 10);
  await mk(cheapProductId, `W43-${tag}-CHEAP-${uniq}`, "W43 Basic Widget", "500.00", 10);
  await mk(emptyProductId, `W43-${tag}-EMPTY-${uniq}`, "W43 Gone Widget", "3500.00", 0);

  const orderId = `ord-w43-${tag}-${uniq}`;
  const orderNumber = `W43-${tag}-${uniq.slice(0, 4).toUpperCase()}`;
  const lineQty = 2;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber,
    status: "delivered",
    totalAmount: "4000.00",
    currency: "NGN",
    paymentStatus: "completed",
    metadata: {},
  });
  const orderLineId = `oli-w43-${tag}-${uniq}`;
  await world.db.insert(schema.orderItems).values({
    id: orderLineId,
    orderId,
    productId: fromProductId,
    productName: "W43 Origin Widget",
    quantity: lineQty,
    unitPrice: "2000.00",
    currency: "NGN",
  });
  await world.db.insert(schema.inventorySnapshots).values({
    id: randomUUID(),
    tenantId: TENANT_ID,
    productId: fromProductId,
    stockQty: "20",
    reservedQty: "2",
    availableQty: "18",
  }).onConflictDoNothing();

  return { orderId, orderNumber, orderLineId, fromProductId, toProductId, cheapProductId, emptyProductId, phone, lineQty };
}

/** Convenience: read one product row's stockQuantity. */
export async function stockOf(world: World, productId: string): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [p] = await world.db.select({ stockQuantity: schema.products.stockQuantity })
    .from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  return Number(p?.stockQuantity ?? NaN);
}
