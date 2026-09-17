/**
 * === W43 fulfillment (Coder A) ===
 * w43-fulfillment-seed.ts — shared seed for the W43 fulfillment/backorder
 * journeys (J322–J326). NOT a journey itself (runner imports journeys
 * explicitly).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, type World } from "../world";

export interface FulfillSeedLine {
  orderLineId: string;
  productId: string;
  qty: number;
}

export interface FulfillSeed {
  orderId: string;
  orderNumber: string;
  phone: string;
  lines: FulfillSeedLine[];
}

/**
 * Seed a PAID order (status 'processing', paymentStatus 'completed') with
 * one product + order line per spec entry and a COMMITTED inventory
 * reservation per line — the exact shape fulfillOrderLines consumes.
 */
export async function seedFulfillOrder(
  world: World,
  tag: string,
  phone: string,
  lines: { qty: number; stock: number }[],
): Promise<FulfillSeed> {
  const schema = await import("../../drizzle/schema");
  const orderId = `ord-w43-${tag}-${randomUUID().slice(0, 8)}`;
  const orderNumber = `W43-${tag}-${randomUUID().slice(0, 4).toUpperCase()}`;

  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber,
    status: "processing",
    totalAmount: "1000.00",
    currency: "NGN",
    paymentStatus: "completed",
    metadata: {},
  });

  const out: FulfillSeedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const productId = `p-w43-${tag}-${i}-${randomUUID().slice(0, 6)}`;
    await world.db.insert(schema.products).values({
      id: productId,
      tenantId: TENANT_ID,
      sku: `W43-${tag}-${i}-${randomUUID().slice(0, 6)}`,
      name: `W43 Widget ${tag}-${i}`,
      price: "500.00",
      currency: "NGN",
      stockQuantity: lines[i].stock,
      status: "active",
    } as any);
    const orderLineId = randomUUID();
    await world.db.insert(schema.orderItems).values({
      id: orderLineId,
      orderId,
      productId,
      productName: `W43 Widget ${tag}-${i}`,
      quantity: lines[i].qty,
      unitPrice: "500.00",
      currency: "NGN",
    });
    // Committed reservation = the paid-order stock leg (stock already left
    // products.stockQuantity at reserve time, so deduct it to mirror reality).
    await world.db.update(schema.products)
      .set({ stockQuantity: lines[i].stock - lines[i].qty } as any)
      .where(eq(schema.products.id, productId));
    await world.db.insert(schema.inventoryReservations).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      orderId,
      productId,
      qty: lines[i].qty,
      status: "committed",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    out.push({ orderLineId, productId, qty: lines[i].qty });
  }

  return { orderId, orderNumber, phone, lines: out };
}

/** Set the sim tenant's allowBackorders flag (J325/J326 toggle). */
export async function setAllowBackorders(world: World, on: boolean): Promise<void> {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  await world.db.update(schema.tenants)
    .set({ allowBackorders: on } as any)
    .where(eq(schema.tenants.id, TENANT_ID));
}
