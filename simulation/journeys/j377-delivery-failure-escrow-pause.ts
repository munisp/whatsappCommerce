// === W45 orders-p0 (Coder C) ===
/**
 * J377 — ORD-7: failed delivery pauses escrow auto-release + opens a
 * redelivery task; terminal RTS (returned) restocks committed items with a
 * stock_adjustments audit row and runs the escrow refund path; the
 * buyer-protection clock is paused (buyerConfirmDeadline NULL → SLA scan
 * skips it).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedEscrow, seedOrderWithItem, seedShipment } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J377",
  name: "delivery failure pauses escrow; RTS restocks + refunds",
  feature: "ORD-7 escrowLifecycle pause + logistics failure consequences",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { handleDeliveryFailure } = await import("../../server/routers/logistics");
    const phone = world.newPhone("j377");
    await world.grantConsent(phone);

    // ── Non-terminal failure: escrow paused + redelivery task opened ──
    const { orderId } = await seedOrderWithItem(world, "j377a", phone);
    const escrowId = await seedEscrow(world, "j377a", orderId, {
      deadline: new Date(Date.now() - 60_000), // clock about to auto-release
    });
    const shipmentId = await seedShipment(world, "j377a", orderId, escrowId);

    const res = await handleDeliveryFailure(world.db, {
      id: shipmentId, orderId, tenantId: TENANT_ID, escrowTxId: escrowId, metadata: {},
    }, { terminal: false, reason: "rider could not reach buyer" });

    assert(res.escrowPaused, "escrow paused on failed delivery");
    assert(res.redeliveryTask, "redelivery task opened");
    const [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrowId));
    assert(esc.state === "escrow_held", `escrow stays held (got ${esc.state})`);
    assert(esc.buyerConfirmDeadline === null, "buyer-protection clock paused (deadline NULL)");
    assert((esc.metadata as any)?.buyerProtectionPaused === true, "pause flag in metadata");
    const [shp] = await world.db.select().from(schema.logisticsShipments)
      .where(eq(schema.logisticsShipments.id, shipmentId));
    assert((shp.metadata as any)?.redeliveryTask?.status === "open", "redelivery task persisted");

    // ── Terminal RTS: restock + refund path ──
    const t = await seedOrderWithItem(world, "j377b", phone, { status: "shipped", stock: 3 });
    // Committed (paid) reservation — cancelOrder must release it exactly once.
    await world.db.insert(schema.inventoryReservations).values({
      id: crypto.randomUUID(),
      tenantId: TENANT_ID,
      orderId: t.orderId,
      productId: t.productId,
      qty: 2,
      status: "committed",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const escrowId2 = await seedEscrow(world, "j377b", t.orderId);
    const shipmentId2 = await seedShipment(world, "j377b", t.orderId, escrowId2);

    const rts = await handleDeliveryFailure(world.db, {
      id: shipmentId2, orderId: t.orderId, tenantId: TENANT_ID, escrowTxId: escrowId2, metadata: {},
    }, { terminal: true, reason: "returned to sender" });

    assert(rts.restocked, "RTS restocked committed items");
    assert(rts.refundInitiated, "RTS initiated the escrow refund path");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, t.orderId));
    assert(ord.status === "cancelled", `RTS order cancelled (got ${ord.status})`);
    const [esc2] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrowId2));
    assert(esc2.state === "refunded", `escrow refunded (got ${esc2.state})`);
    // Reservation released + stock audit written.
    const [rsv] = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, t.orderId));
    assert(rsv.status === "released", `committed reservation released (got ${rsv.status})`);
    const audit = await world.db.select().from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.refId, t.orderId));
    assert(audit.some((a: any) => a.refType === "order_cancel"), "restock audit row present");
    // Replay: terminal RTS a second time changes nothing (exactly-once).
    const replay = await handleDeliveryFailure(world.db, {
      id: shipmentId2, orderId: t.orderId, tenantId: TENANT_ID, escrowTxId: escrowId2, metadata: {},
    }, { terminal: true, reason: "returned to sender" });
    assert(!replay.restocked && !replay.refundInitiated, "RTS replay is a no-op");
  },
};
// === END W45 orders-p0 ===
