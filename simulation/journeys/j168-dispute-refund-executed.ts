/**
 * J168 — W30 dispute resolution EXECUTES the refund (verify-v1 #7 + #9):
 * a full_refund_to_buyer resolution moves real money through the hardened
 * atomic helper AND calls the provider refund API (PSP custody) — the mock
 * Paystack outbound /refund call is asserted. The old flow emailed "refund
 * issued" while moving no money. Also proves refunds.processed is reachable
 * via evidence-confirmed provider refund (orderCrud.confirmRefundProcessed).
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller, adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J168",
  name: "dispute resolution executes provider refund",
  feature: "W30 dispute review money movement + processed reachable",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // PSP custody so the provider refund path executes.
    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    try {
      const phone = world.newPhone("dispute-refund");
      await world.grantConsent(phone);
      const order = await createChatOrderViaNlp(world, phone, {
        items: [{ product: "Jollof Rice", quantity: 1 }],
      });
      const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);

      let escrow: any | null = null;
      await world.waitFor(async () => {
        const [e] = await world.db.select().from(schema.escrowTransactions)
          .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
        escrow = e ?? null;
        return !!escrow && escrow.state === "escrow_held";
      }, 10000, "escrow hold created in escrow_held");

      // Raise a real dispute, then resolve it full_refund_to_buyer.
      const tenant = await tenantCaller(TENANT_ID);
      const dispute = await tenant.escrowDispute.raise({
        escrowTxId: escrow.id, orderId: order.orderId, tenantId: TENANT_ID,
        raisedBy: "buyer", reason: "not_received", description: "never arrived",
      });
      const admin = await adminCaller();
      await admin.escrowDispute.review({
        disputeId: dispute.id,
        resolution: "full_refund_to_buyer",
        resolverNotes: "tracking shows no delivery",
      });

      // Money moved: escrow refunded (internal) + provider refund API called.
      const [esc] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(esc.state === "refunded", `dispute resolution refunded the escrow (got ${esc.state})`);
      const refundCalls = world.outbound.all().filter((c: any) =>
        String(c.url ?? "").includes("paystack") && String(c.url ?? "").includes("/refund"));
      assert(refundCalls.length >= 1, "provider refund API was called (paystack /refund)");

      // Double resolution is impossible: dispute_resolved is consumed once.
      let conflict = false;
      try {
        await admin.escrowDispute.review({ disputeId: dispute.id, resolution: "full_release_to_merchant" });
      } catch (e: any) {
        conflict = /already resolved|concurrently/i.test(String(e?.message ?? ""));
      }
      assert(conflict, "second resolution rejected (single terminal consumption)");
      const [esc2] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(esc2.state === "refunded", "escrow stays refunded after rejected re-resolution");

      // ── refunds.processed is REACHABLE (verify-v1 #9) ──────────────────
      const refund = await tenant.orderCrud.refund({
        orderId: order.orderId, amount: 1.0, reason: "goodwill top-up",
      }).catch(() => null);
      // order.paymentStatus is already "refunded" after the full dispute
      // refund, so orderCrud.refund may refuse — use a fresh paid order for
      // the processed-reachability proof.
      let refundId = refund?.refundId as string | undefined;
      if (!refundId) {
        const phone2 = world.newPhone("refund-processed");
        await world.grantConsent(phone2);
        const order2 = await createChatOrderViaNlp(world, phone2, {
          items: [{ product: "Grilled Chicken", quantity: 1 }],
        });
        const pay2 = await paystackChargeSuccess(world, { reference: order2.paymentRef!, amountMajor: order2.total });
        assert(pay2.status === 200, "second payment confirmed");
        const r2 = await tenant.orderCrud.refund({ orderId: order2.orderId, amount: 5.0, reason: "damaged item" });
        refundId = r2.refundId;
      }
      assert(refundId, "refund row created");
      const approved = await tenant.orderCrud.processRefund({ refundId: refundId!, action: "approved" });
      assert(approved.ok, "refund approved");
      // Provider refund was executed (queued → honest 'approved', not claimed paid).
      const [row] = await world.db.select().from(schema.refunds)
        .where(eq(schema.refunds.id, refundId!)).limit(1);
      const meta = (row.metadata ?? {}) as any;
      assert(meta.refundExecution?.executed === true, "provider refund executed on approval");
      // Paystack queues refunds — honest vocab is "initiated", never "paid"
      // until the provider confirms (confirmRefundProcessed below).
      assert(meta.refundExecution?.vocabulary === "refund_initiated", `honest vocabulary (got ${meta.refundExecution?.vocabulary})`);
      const confirmed = await tenant.orderCrud.confirmRefundProcessed({
        refundId: refundId!, evidence: "paystack refund queue confirmation", providerReference: "sim-ref",
      });
      assert(confirmed.status === "processed", `refunds.processed reachable (got ${confirmed.status})`);
      const [finalRow] = await world.db.select().from(schema.refunds)
        .where(eq(schema.refunds.id, refundId!)).limit(1);
      assert(finalRow.status === "processed", "refund row processed");
    } finally {
      await world.db.update(schema.escrowConfig).set({ custodyMode: "pssp" })
        .where(eq(schema.escrowConfig.id, 1));
    }
  },
};
