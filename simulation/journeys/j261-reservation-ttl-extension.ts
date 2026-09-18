/**
 * === W38 stock integrity (Coder C, ORD-3) ===
 * J261 — Reservation TTL extension while a payment attempt is in flight
 * (slow-webhook proof). Before W38 the sweeper released any expired
 * reservation whose order wasn't yet paymentStatus='completed'; a webhook
 * landing after the release found 0 reserved rows and the paid order was
 * oversold.
 *
 * Proof: expired reservation + in-flight paymentIntents row → sweeper
 * EXTENDS (stock stays reserved) → commitReservations still succeeds →
 * paid order keeps its stock. Once the attempt goes stale the sweeper
 * releases normally.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J261",
  name: "reservation TTL extension (slow webhook, no oversell)",
  feature: "ORD-3 sweeper extends TTL when payment attempt in flight",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const inv = await import("../../server/services/inventory");

    const productId = "p-jollof";
    await world.db.update(schema.products).set({ stockQuantity: 50 }).where(eq(schema.products.id, productId));

    const orderId = "w38-j261-order";
    await world.db.insert(schema.orders).values({
      id: orderId,
      tenantId: TENANT_ID,
      customerId: "cust-w38-j261",
      orderNumber: "SIM-W38-J261",
      status: "pending",
      totalAmount: "2500.00",
      currency: "NGN",
      paymentStatus: "initiated",
    });
    await world.db.insert(schema.orderItems).values({
      orderId, productId, productName: "Jollof Rice", quantity: 1, unitPrice: "2500.00",
    });
    await inv.reserveStock(world.db, TENANT_ID, orderId, [{ productId, qty: 1 }]);

    // Force the reservation to be EXPIRED (TTL elapsed).
    await world.db.execute(
      `UPDATE inventory_reservations SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE "orderId" = '${orderId}'`,
    );

    // A payment attempt is IN FLIGHT (buyer at PSP checkout, webhook slow).
    await world.db.insert(schema.paymentIntents).values({
      id: "w38-j261-intent",
      tenantId: TENANT_ID,
      orderId,
      customerId: "cust-w38-j261",
      amount: "2500.00",
      currency: "NGN",
      provider: "paystack",
      status: "pending",
      idempotencyKey: "w38-j261-idem",
    });

    // Sweep: must EXTEND, not release.
    const sweep1 = await inv.releaseExpiredReservations(world.db);
    let rows = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, orderId));
    assert(rows.length === 1 && rows[0].status === "reserved",
      `ORD-3: reservation kept reserved under in-flight attempt (got ${rows[0]?.status}, extended=${sweep1.extended})`);
    assert(new Date(rows[0].expiresAt).getTime() > Date.now(), "TTL was extended into the future");
    let [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 49, `stock still reserved (got ${prod.stockQuantity})`);

    // The slow webhook finally lands → commitReservations finds the row and
    // the paid order keeps its stock (no oversell).
    const committed = await inv.commitReservations(world.db, orderId);
    assert(committed === 1, `slow-webhook commit succeeded (got ${committed}) — no oversell`);

    // Second scenario: attempt goes STALE (no recent activity) → sweeper
    // releases normally and stock returns to the pool.
    const orderId2 = "w38-j261-order2";
    await world.db.insert(schema.orders).values({
      id: orderId2,
      tenantId: TENANT_ID,
      customerId: "cust-w38-j261b",
      orderNumber: "SIM-W38-J261B",
      status: "pending",
      totalAmount: "2500.00",
      currency: "NGN",
      paymentStatus: "initiated",
    });
    await inv.reserveStock(world.db, TENANT_ID, orderId2, [{ productId, qty: 1 }]);
    await world.db.execute(
      `UPDATE inventory_reservations SET "expiresAt" = NOW() - INTERVAL '1 minute' WHERE "orderId" = '${orderId2}'`,
    );
    await world.db.insert(schema.paymentIntents).values({
      id: "w38-j261-intent2",
      tenantId: TENANT_ID,
      orderId: orderId2,
      customerId: "cust-w38-j261b",
      amount: "2500.00",
      currency: "NGN",
      provider: "paystack",
      status: "pending",
      idempotencyKey: "w38-j261-idem2",
    });
    // Stale the attempt (touched > TTL ago).
    await world.db.execute(
      `UPDATE payment_intents SET "updatedAt" = NOW() - INTERVAL '30 minutes' WHERE id = 'w38-j261-intent2'`,
    );
    await inv.releaseExpiredReservations(world.db);
    rows = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, orderId2));
    assert(rows.length === 1 && rows[0].status === "released",
      `stale attempt → reservation released (got ${rows[0]?.status})`);
    [prod] = await world.db.select().from(schema.products).where(eq(schema.products.id, productId)).limit(1);
    assert(prod.stockQuantity === 49, `stock returned after stale release (got ${prod.stockQuantity}) — only the committed unit stays out`);
  },
};
