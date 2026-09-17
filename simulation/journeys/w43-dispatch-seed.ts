// === W43 dispatch (Coder C) ===
/**
 * w43-dispatch-seed.ts — shared seed for the W43 dispatch journeys
 * (J332–J336). NOT a journey itself (runner imports journeys explicitly).
 */
import { randomUUID } from "node:crypto";
import { TENANT_ID, type World } from "../world";

export interface DispatchSeed {
  orderId: string;
  orderNumber: string;
  shipmentId: string;
  trackingId: string;
  escrowId: string;
  phone: string;
}

/**
 * Seed a paid order whose shipment is OUT_FOR_DELIVERY — the post-dispatch
 * window both W43 features operate on (POD capture + address change).
 */
export async function seedDispatchOrder(world: World, tag: string, phone: string): Promise<DispatchSeed> {
  const schema = await import("../../drizzle/schema");
  const orderId = `ord-w43-${tag}-${randomUUID().slice(0, 8)}`;
  const orderNumber = `W43-${tag}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const shipmentId = `shp-w43-${tag}-${randomUUID().slice(0, 8)}`;
  const trackingId = `TRK-W43-${tag}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const escrowId = randomUUID();

  await world.db.insert(schema.orders).values({
    id: orderId,
    tenantId: TENANT_ID,
    customerId: phone,
    orderNumber,
    status: "shipped",
    totalAmount: "5000.00",
    currency: "NGN",
    paymentStatus: "completed",
    shippingAddress: { line1: "1 Old Road", city: "Lagos", country: "NG" },
    metadata: {},
  });
  await world.db.insert(schema.orderItems).values({
    orderId,
    productId: "p-jollof",
    productName: "Jollof Rice",
    quantity: 2,
    unitPrice: "2500.00",
    currency: "NGN",
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
  await world.db.insert(schema.logisticsShipments).values({
    id: shipmentId,
    orderId,
    tenantId: TENANT_ID,
    escrowTxId: escrowId,
    provider: "shipbubble",
    carrierName: "Sim Logistics",
    trackingId,
    status: "out_for_delivery",
    outForDeliveryAt: new Date(),
    webhookPayloads: [],
  });
  return { orderId, orderNumber, shipmentId, trackingId, escrowId, phone };
}

/** Set/clear tenants.requirePod (default false). */
export async function setRequirePod(world: World, on: boolean): Promise<void> {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  await world.db.update(schema.tenants).set({ requirePod: on }).where(eq(schema.tenants.id, TENANT_ID));
}

/** Set/clear tenants.allowPostDispatchAddressChange (default true). */
export async function setAllowAddressChange(world: World, on: boolean): Promise<void> {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  await world.db.update(schema.tenants).set({ allowPostDispatchAddressChange: on }).where(eq(schema.tenants.id, TENANT_ID));
}

/** Register a staff user so merchant commands pass isTenantStaffPhone. */
export async function addStaffUser(world: World, tag: string, phone: string): Promise<void> {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.users).values({
    openId: `sim-merchant-w43-${tag}-${phone}`,
    name: `Sim Merchant W43 ${tag}`,
    phone,
    tenantId: TENANT_ID,
    lastSignedIn: new Date(),
  }).onConflictDoNothing();
}
