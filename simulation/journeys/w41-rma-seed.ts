/**
 * w41-rma-seed.ts — shared seed for the W41 RMA/display-FX journeys
 * (J300–J306). NOT a journey itself (runner imports journeys explicitly).
 */
import { randomUUID } from "node:crypto";
import { TENANT_ID, type World } from "../world";

export interface RmaSeed {
  orderId: string;
  orderNumber: string;
  escrowId: string;
  productId: string;
  phone: string;
  totalCents: number;
}

/**
 * Seed a delivered order (2 × Jollof Rice = ₦5,000) with an escrow_held
 * escrow, a COMMITTED inventory reservation and an inventory_snapshots row —
 * the exact shape the W38 restock + refund paths operate on.
 */
export async function seedRmaOrder(world: World, tag: string, phone: string): Promise<RmaSeed> {
  const schema = await import("../../drizzle/schema");
  const orderId = `ord-w41-${tag}-${randomUUID().slice(0, 8)}`;
  const productId = "p-jollof";
  const totalCents = 500_000; // ₦5,000.00 in kobo

  const orderNumber = `W41-${tag}-${randomUUID().slice(0, 4).toUpperCase()}`;
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber,
    status: "delivered",
    totalAmount: "5000.00",
    currency: "NGN",
    paymentStatus: "completed",
    metadata: {},
  });
  await world.db.insert(schema.orderItems).values({
    orderId,
    productId,
    productName: "Jollof Rice",
    quantity: 2,
    unitPrice: "2500.00",
    currency: "NGN",
  });
  const escrowId = randomUUID();
  await world.db.insert(schema.escrowTransactions).values({
    id: escrowId,
    tenantId: TENANT_ID,
    orderId,
    customerId: phone,
    amount: "5000.00",
    currency: "NGN",
    state: "escrow_held",
  });
  // Committed reservation (paid-order stock leg) + snapshot row.
  await world.db.insert(schema.inventoryReservations).values({
    id: randomUUID(),
    tenantId: TENANT_ID,
    orderId,
    productId,
    qty: 2,
    status: "committed",
    expiresAt: new Date(Date.now() + 3600_000),
  }).onConflictDoNothing();
  await world.db.insert(schema.inventorySnapshots).values({
    id: randomUUID(),
    tenantId: TENANT_ID,
    productId,
    stockQty: "50",
    reservedQty: "2",
    availableQty: "48",
  }).onConflictDoNothing();

  return { orderId, orderNumber, escrowId, productId, phone, totalCents };
}
