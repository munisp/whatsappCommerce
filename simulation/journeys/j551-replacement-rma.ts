// === W54 disputes ===
/**
 * J551 — DISP-7: replacement resolution path. Resolving a dispute as
 * "replacement" opens an RMA on the W41 rail with a TWO-WAY metadata link
 * (rma.metadata.disputeId ↔ dispute.metadata.replacementRmaId), parks the
 * escrow in dispute_resolved with money UNTOUCHED (no refund, no release),
 * and writes an audit entry.
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J551",
  name: "DISP-7: replacement resolution opens a linked RMA, money untouched",
  feature: "W54 dispute replacement → RMA link",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j551-buyer");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(pay.status === 200, `webhook accepted (got ${pay.status})`);
    let escrow: any | null = null;
    await world.waitFor(async () => {
      const [e] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
      escrow = e ?? null;
      return !!escrow && escrow.state === "escrow_held";
    }, 10000, "escrow hold");
    const { raiseEscrowDispute } = await import("../../server/services/disputes");
    const dispute = await raiseEscrowDispute(world.db as any, {
      escrowTxId: escrow!.id, orderId: order.orderId, tenantId: TENANT_ID,
      raisedBy: "buyer", reason: "damaged", description: "J551 arrived broken — send a replacement",
    });

    const admin = await adminCaller();
    await admin.escrowDispute.review({
      disputeId: dispute.id,
      resolution: "replacement",
      resolverNotes: "Replacement unit to be shipped",
    });

    const [d1] = await world.db.select().from(schema.escrowDisputes)
      .where(eq(schema.escrowDisputes.id, dispute.id));
    assert(d1.resolution === "replacement", `resolution replacement (got ${d1.resolution})`);
    const rmaId = (d1.metadata as any)?.replacementRmaId;
    assert(typeof rmaId === "string" && rmaId.length > 0, "dispute carries the forward RMA link");

    const [rma] = await world.db.select().from(schema.rmaRequests)
      .where(eq(schema.rmaRequests.id, rmaId));
    assert(rma, "RMA row exists");
    assert(rma.orderId === order.orderId && rma.tenantId === TENANT_ID, "RMA bound to the dispute order");
    assert((rma.metadata as any)?.disputeId === dispute.id, "RMA carries the reverse dispute link");
    assert((rma.metadata as any)?.source === "dispute_replacement", "RMA source honestly labelled");

    // Money untouched: escrow parked dispute_resolved, order NOT refunded.
    const [e1] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id));
    assert(e1.state === "dispute_resolved", `escrow parked dispute_resolved (got ${e1.state})`);
    const [o1] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
    assert(o1.status !== "refunded", "order not refunded on the replacement path");

    const audits = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "dispute.replacement_rma"), eq(schema.auditLogs.entityId, dispute.id)));
    assert(audits.length >= 1, "replacement resolution audited");
  },
};
