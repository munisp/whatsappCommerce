/**
 * J167 — W30 cancel-of-paid-order refunds the escrow (verify-v1 #8):
 * orderCrud.cancel of a paid, escrow-backed order must never orphan the
 * escrow (previously the SLA scan later auto-RELEASED it to the merchant).
 * The real atomic refund runs as part of the cancel flow: escrow → refunded,
 * order payment → refunded.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J167",
  name: "cancel of paid order → escrow refunded",
  feature: "W30 orderCrud.cancel escrow refund",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("cancel-refund");
    await world.grantConsent(phone);

    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    assert(order.paymentRef, "payment reference captured");
    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);

    let escrow: any | null = null;
    await world.waitFor(async () => {
      const [e] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
      escrow = e ?? null;
      return !!escrow && escrow.state === "escrow_held";
    }, 10000, "escrow hold created in escrow_held");

    // Cancel the paid order via the REAL router path.
    const tenant = await tenantCaller(TENANT_ID);
    const res = await tenant.orderCrud.cancel({ orderId: order.orderId, reason: "buyer changed mind" });
    assert(res.ok === true, "cancel succeeded");
    assert(res.escrowRefunded === true, `cancel refunded the escrow (got ${JSON.stringify(res)})`);

    const [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    assert(esc.state === "refunded", `escrow refunded after cancel (got ${esc.state})`);
    assert(esc.refundedAt, "refundedAt stamped");

    const [ord] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(ord.status === "cancelled", `order cancelled (got ${ord.status})`);
    assert(ord.paymentStatus === "refunded", `order payment refunded (got ${ord.paymentStatus})`);

    // The cancelled-order escrow must NEVER be releasable: a bulk/admin
    // release attempt against the refunded escrow is rejected.
    const { settleEscrowAtomic } = await import("../../server/routers/escrow");
    const { getDb } = await import("../../server/db");
    const db = await getDb();
    const settle = await settleEscrowAtomic(db as any, esc.id, {
      autoConfirmed: true,
      allowedFromStates: ["delivery_confirmed", "escrow_held", "dispute_resolved"],
    });
    assert(settle.transitioned === false, "refunded escrow can never be released");
  },
};
