// === W44 preorders-offers (Coder B) ===
/**
 * w44-preorder-offer-seed.ts — shared seed for the W44 preorders/offers
 * journeys (J342–J346). NOT a journey itself (runner imports journeys
 * explicitly).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, type World } from "../world";

export interface PreorderSeed {
  productId: string;
  orderId: string;
  orderNumber: string;
  lineId: string;
  escrowId: string;
  phone: string;
  availableAt: Date;
}

/** Create a preorder-enabled product (available in the FUTURE by default). */
export async function seedPreorderProduct(
  world: World,
  tag: string,
  opts: { price?: string; stock?: number; availableAt?: Date; minPriceCents?: number | null } = {},
): Promise<{ productId: string; name: string; availableAt: Date }> {
  const schema = await import("../../drizzle/schema");
  const productId = `p-w44-${tag}-${randomUUID().slice(0, 8)}`;
  const availableAt = opts.availableAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const name = `W44 Preorder ${tag}`;
  await world.db.insert(schema.products).values({
    id: productId,
    tenantId: TENANT_ID,
    sku: `SIM-W44-${tag.toUpperCase()}-${randomUUID().slice(0, 4)}`,
    name,
    description: "W44 preorder catalog item",
    category: "sim",
    price: opts.price ?? "5000.00",
    currency: "NGN",
    status: "active",
    stockQuantity: opts.stock ?? 20,
    preorderEnabled: true,
    preorderAvailableAt: availableAt,
    minPriceCents: opts.minPriceCents ?? null,
  });
  return { productId, name, availableAt };
}

/** Seed a PAID pre-order: preorder line + preorder metadata + held escrow. */
export async function seedPreorderOrder(world: World, tag: string, phone: string): Promise<PreorderSeed> {
  const schema = await import("../../drizzle/schema");
  const prod = await seedPreorderProduct(world, tag);
  const orderId = `ord-w44-${tag}-${randomUUID().slice(0, 8)}`;
  const orderNumber = `W44-${tag}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const lineId = randomUUID();
  const escrowId = randomUUID();
  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber,
    status: "confirmed",
    totalAmount: "5000.00",
    currency: "NGN",
    paymentStatus: "completed",
    metadata: {
      preorder: {
        availableAt: prod.availableAt.toISOString(),
        depositPct: 100,
        totalCents: 500000,
        depositCents: 500000,
        lineIds: [lineId],
      },
    },
  });
  await world.db.insert(schema.orderItems).values({
    id: lineId,
    orderId,
    productId: prod.productId,
    productName: prod.name,
    quantity: 1,
    unitPrice: "5000.00",
    currency: "NGN",
    status: "preorder",
  });
  await world.db.insert(schema.escrowTransactions).values({
    id: escrowId,
    tenantId: TENANT_ID,
    orderId,
    customerId: phone,
    amount: "5000.00",
    currency: "NGN",
    state: "escrow_held",
  });
  return { productId: prod.productId, orderId, orderNumber, lineId, escrowId, phone, availableAt: prod.availableAt };
}

/** Set tenants.preorderDepositPct (restore to 100 afterwards). */
export async function setPreorderDepositPct(world: World, pct: number): Promise<void> {
  const schema = await import("../../drizzle/schema");
  await world.db.update(schema.tenants).set({ preorderDepositPct: pct }).where(eq(schema.tenants.id, TENANT_ID));
}
