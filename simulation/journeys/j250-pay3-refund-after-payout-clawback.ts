/**
 * === W38 money-integrity (Coder A) ===
 * J250 — PAY-3 refund-after-payout: approving a refund when the escrow has
 * already SETTLED (merchant paid out) must never silently double-spend
 * platform funds — a merchant_clawbacks debit is recorded in the flow, and
 * a replayed approval neither re-refunds nor double-records the clawback.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller, expectTrpcError } from "./helpers";

export const journey: Journey = {
  id: "J250",
  name: "PAY-3: refund after payout records a merchant clawback",
  feature: "W38 merchant_clawbacks + same-tx escrow FOR UPDATE load",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay3-claw");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, "webhook accepted");

    const [escrow] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    assert(escrow, "escrow exists");

    // Escrow already settled — the merchant has been PAID OUT.
    await world.db.update(schema.escrowTransactions)
      .set({ state: "settled", settledAt: new Date() })
      .where(eq(schema.escrowTransactions.id, escrow.id));

    const tenant = await tenantCaller(TENANT_ID);
    const { refundId } = await tenant.orderCrud.refund({ orderId: order.orderId, amount: order.total, reason: "J250 refund after payout" });
    const res = await tenant.orderCrud.processRefund({ refundId, action: "approved" });
    assert(res.ok === true, "refund approved (buyer still gets money)");
    assert(res.clawbackId, `clawback recorded (got ${JSON.stringify(res)})`);

    const cents = Math.round(order.total * 100);
    const clawbacks = await world.db.select().from(schema.merchantClawbacks)
      .where(eq(schema.merchantClawbacks.refundId, refundId));
    assert(clawbacks.length === 1, `exactly one clawback (got ${clawbacks.length})`);
    assert(clawbacks[0].amountCents === cents, `clawback amount ${clawbacks[0].amountCents} == refund ${cents}`);
    assert(clawbacks[0].status === "pending", "clawback pending recovery");
    assert(clawbacks[0].escrowId === escrow.id, "clawback tied to the settled escrow");

    const [row] = await world.db.select().from(schema.refunds).where(eq(schema.refunds.id, refundId));
    const meta = (row.metadata ?? {}) as Record<string, any>;
    assert(meta.refundExecution?.clawbackId === res.clawbackId, "refund metadata references the clawback");

    // ── Replay: refused by the claim-first guard; still exactly ONE clawback
    await expectTrpcError(tenant.orderCrud.processRefund({ refundId, action: "approved" }), "CONFLICT", "replayed approval refused");
    const again = await world.db.select().from(schema.merchantClawbacks)
      .where(eq(schema.merchantClawbacks.refundId, refundId));
    assert(again.length === 1, "no double clawback on replay");
  },
};
