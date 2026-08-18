/**
 * J120 — E2 stakeholder journey (field ops): two merchant devices queue
 * offline orders while disconnected → both sync on reconnect → the LAST
 * stock unit is sold exactly once (reserveStock's conditional decrement
 * resolves the conflict; the loser gets a shortage, no order, no payment)
 * → the winner's sync is replay-safe (clientRef idempotency — a retried
 * sync returns the same order, no double reserve).
 *
 * Gap fixed this wave: offlineOrders.createOfflineOrder (+ cod router)
 * accept an additive clientRef so a re-synced queued order dedupes instead
 * of minting a duplicate order.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J120",
  name: "offline order sync — two devices, last stock unit",
  feature: "E2 offline sync + stock-conflict resolution end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const deviceA = await tenantCaller(TENANT_ID, { userId: 1200 });
    const deviceB = await tenantCaller(TENANT_ID, { userId: 1201 });

    // Confirm the seeded "last unit" product really has exactly one in stock.
    const [before] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-lastunit")).limit(1);
    assert(before.stockQuantity === 1, `last unit in stock (got ${before.stockQuantity})`);

    // ── Both devices queued a sale of the last unit while offline ────────
    const queued = {
      tenantId: TENANT_ID,
      items: [{ productId: "p-lastunit", qty: 1 }],
      paymentMethod: "cash" as const,
      currency: "NGN" as const,
    };

    // ── Reconnect: device A syncs first and claims the unit ──────────────
    const syncA = await deviceA.cod.createOfflineOrder({
      ...queued,
      customerName: "Walk-in A",
      customerPhone: world.newPhone("e2a"),
      note: "queued offline at 09:14",
      clientRef: "deviceA-queue-0001",
    });
    assert(syncA.created === true && syncA.duplicate !== true, "device A sync creates the order");
    assert(syncA.paymentStatus === "completed", "cash sale recorded as paid");
    const [afterA] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-lastunit")).limit(1);
    assert(afterA.stockQuantity === 0, `unit reserved for A (stock ${afterA.stockQuantity})`);
    const resA = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, syncA.orderId!));
    assert(resA.length === 1 && resA[0].status === "reserved", "reservation recorded for A");

    // ── Device B syncs its queue: conflict resolved, NO double-sell ──────
    let conflict: Error | null = null;
    try {
      await deviceB.cod.createOfflineOrder({
        ...queued,
        customerName: "Walk-in B",
        customerPhone: world.newPhone("e2b"),
        note: "queued offline at 09:15",
        clientRef: "deviceB-queue-0001",
      });
    } catch (e: any) {
      conflict = e;
    }
    assert(conflict, "device B sync fails — the unit is gone");
    assert(/Insufficient stock/.test(String(conflict!.message)),
      `shortage surfaced to the device (got ${String(conflict!.message).slice(0, 120)})`);
    const [afterB] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-lastunit")).limit(1);
    assert(afterB.stockQuantity === 0, "stock never goes negative");
    const ordersForProduct = await world.db.select().from(schema.orderItems)
      .where(eq(schema.orderItems.productId, "p-lastunit"));
    assert(ordersForProduct.length === 1, `exactly one order line for the last unit (got ${ordersForProduct.length})`);
    const paymentsB = (await world.db.select().from(schema.paymentTransactions)
      .where(and(eq(schema.paymentTransactions.tenantId, TENANT_ID), eq(schema.paymentTransactions.provider, "offline-cash"))))
      .filter((t: any) => t.orderId !== syncA.orderId);
    assert(paymentsB.length === 0, "no payment recorded for the losing device");

    // ── Device A retries its sync (reconnect timeout) → idempotent ───────
    const replayA = await deviceA.cod.createOfflineOrder({
      ...queued,
      customerName: "Walk-in A",
      customerPhone: world.newPhone("e2a2"), // even a re-keyed phone dedupes
      clientRef: "deviceA-queue-0001",
    });
    assert(replayA.created === true && replayA.duplicate === true, "replayed sync flagged as duplicate");
    assert(replayA.orderId === syncA.orderId && replayA.orderNumber === syncA.orderNumber,
      "replay returns the SAME order");
    const ordersAfterReplay = await world.db.select().from(schema.orderItems)
      .where(eq(schema.orderItems.productId, "p-lastunit"));
    assert(ordersAfterReplay.length === 1, "replay did not mint a second order");
    const [afterReplay] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-lastunit")).limit(1);
    assert(afterReplay.stockQuantity === 0, "replay did not double-reserve stock");
    const paymentsA = (await world.db.select().from(schema.paymentTransactions))
      .filter((t: any) => t.orderId === syncA.orderId);
    assert(paymentsA.length === 1, "exactly one payment row for A across both syncs");
  },
};
