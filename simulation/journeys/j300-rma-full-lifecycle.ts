/**
 * === W41 rma-fx (Coder C) ===
 * J300 — RMA full lifecycle: requested → approved → received → restocked →
 * refunded (PSP path), with stock restored via the W38 unified helpers.
 *
 * Asserts: inventory_snapshots availableQty credited back, the committed
 * reservation is released (products.stockQuantity restored), the escrow is
 * refunded via refundEscrowAtomic (state + metadata.refundedAmount), and the
 * RMA lands in 'refunded' with refundedCents recorded.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedRmaOrder } from "./w41-rma-seed";

export const journey: Journey = {
  id: "J300",
  name: "RMA full lifecycle (restock + PSP refund)",
  feature: "rma_requests state machine + W38 restock/refund reuse",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { requestReturn, decideReturn, receiveAndRestock, refundReturn } = await import("../../server/services/rma");
    const phone = world.newPhone("j300");
    const seed = await seedRmaOrder(world, "j300", phone);
    const notify = { waSend: async () => {}, tgSend: async () => {} };

    // 1. Buyer requests the return.
    const { rma } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed.orderId,
      reason: "arrived damaged", ...notify,
    });
    assert(rma.status === "requested", `rma requested (got ${rma.status})`);
    assert(rma.requestedVia === "whatsapp", "channel recorded");

    // Duplicate open request is refused.
    let dupThrew = false;
    try {
      await requestReturn(world.db, { tenantId: TENANT_ID, buyerRef: phone, orderId: seed.orderId, reason: "again", ...notify });
    } catch (e: any) { dupThrew = e?.code === "CONFLICT"; }
    assert(dupThrew, "duplicate open RMA refused");

    // 2. Merchant approves.
    const approved = await decideReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, approve: true, ...notify });
    assert(approved.status === "approved", "approved");

    // 3. Goods received → restock.
    const before = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, seed.productId)).limit(1))[0];
    const restocked = await receiveAndRestock(world.db, { rmaId: rma.id, tenantId: TENANT_ID, ...notify });
    assert(restocked.status === "restocked", `restocked (got ${restocked.status})`);

    const after = (await world.db.select().from(schema.products)
      .where(eq(schema.products.id, seed.productId)).limit(1))[0];
    assert(Number(after.stockQuantity) === Number(before.stockQuantity) + 2,
      `products stock +2 (${before.stockQuantity} → ${after.stockQuantity})`);
    const [snap] = await world.db.select().from(schema.inventorySnapshots)
      .where(and(eq(schema.inventorySnapshots.tenantId, TENANT_ID), eq(schema.inventorySnapshots.productId, seed.productId)));
    assert(Number(snap.availableQty) === 50, `snapshot available restored to 50 (got ${snap.availableQty})`);
    const [resv] = await world.db.select().from(schema.inventoryReservations)
      .where(eq(schema.inventoryReservations.orderId, seed.orderId));
    assert(resv.status === "released", `committed reservation released (got ${resv.status})`);

    // 4. Refund via the W38 PSP path.
    const refunded = await refundReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, method: "psp", ...notify });
    assert(refunded.refundedCents === seed.totalCents, `refunded ${seed.totalCents} kobo (got ${refunded.refundedCents})`);
    const [escrow] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, seed.escrowId));
    assert(escrow.state === "refunded", `escrow refunded (got ${escrow.state})`);
    assert(Number((escrow.metadata as any)?.refundedAmount) === 5000, "escrow refundedAmount recorded");
    const [finalRma] = await world.db.select().from(schema.rmaRequests)
      .where(eq(schema.rmaRequests.id, rma.id));
    assert(finalRma.status === "refunded" && finalRma.refundMethod === "psp", "RMA terminal refunded/psp");
  },
};
