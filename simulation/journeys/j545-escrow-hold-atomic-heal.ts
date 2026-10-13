/**
 * J545 — the escrow hold created on payment confirmation is atomic and
 * self-healing (assurance finding AF-06).
 *
 * Before the fix, confirmProviderPayment wrote the escrow hold, the PSP-mode
 * wallet transaction and the wallet balance as three separate statements
 * AFTER claiming the payment. A failure between them left a hold whose
 * wallet was never credited; and because the payment was already
 * 'completed', every provider redelivery took the "already-completed" branch
 * and never touched the hold again — the gap could not heal.
 *
 * Through the REAL /api/webhooks/paystack handler in PSP custody mode:
 *   1. the wallet-transaction insert for this order is made to fail → the webhook still acks 200 (W48
 *      PERF-API-1/INT-1: it acks the PSP before running this work at all), but NEITHER the hold NOR a
 *      wallet credit exists once that post-ack work actually runs (no half state);
 *   2. the failure is lifted and Paystack redelivers → the hold AND the
 *      wallet credit are created, exactly once;
 *   3. a further redelivery changes nothing.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J545",
  name: "escrow hold atomic + healed on replay (AF-06)",
  feature: "confirmProviderPayment escrow hold transaction + replay retry",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const [cfg] = await world.db.select().from(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1)).limit(1);
    const originalMode = cfg?.custodyMode ?? "pssp";
    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" }).where(eq(schema.escrowConfig.id, 1));
    let constraintAdded = false;
    try {
      const phone = world.newPhone("af06");
      await world.grantConsent(phone);
      const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
      assert(order.paymentRef, "order has a payment reference");

      const walletBalance = async () => {
        const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
        return w ? Math.round(parseFloat(w.escrowBalance) * 100) : 0;
      };
      const holds = () => world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.orderId, order.orderId));
      const credits = () => world.db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.orderId, order.orderId));
      const balanceBefore = await walletBalance();

      // === W48 PERF-API-1/INT-1 (unrelated wave, merged in after this journey was first written): the
      // webhook now acks 200 to the PSP FIRST, before any confirm/hook work runs — so a DB failure inside
      // that work no longer surfaces as an HTTP 500 for the PSP to retry on; the response is always 200
      // regardless of what happens after. The real outcome now has to be observed by polling the actual DB
      // state (which is what steps 1-3 already did for everything EXCEPT the HTTP status itself), not by
      // trusting the synchronous response — the server keeps running the confirm/hook work after the
      // response is already sent, so a plain `await` on the HTTP call proves nothing about whether that
      // work has finished yet.
      const orderPaymentStatus = async () => {
        const [o] = await world.db.select({ paymentStatus: schema.orders.paymentStatus }).from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
        return o?.paymentStatus;
      };

      // 1. Make the wallet-transaction write for THIS order fail.
      await world.db.execute(
        `ALTER TABLE wallet_transactions ADD CONSTRAINT j475_block CHECK (order_id IS DISTINCT FROM '${order.orderId}') NOT VALID`,
      );
      constraintAdded = true;
      const failed = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(failed.status === 200, `webhook acked (got ${failed.status})`);
      // The payment-completed transition runs BEFORE the (now-failing) hold creation, in the same
      // continued post-ack execution — waiting for it is the signal that hold creation has been attempted
      // (and, since it throws synchronously in that same call chain, rolled back) by the time we check.
      await world.waitFor(async () => (await orderPaymentStatus()) === "completed", 5000, "payment settles to completed despite the hold write failing post-ack");
      assert((await holds()).length === 0, "no half state: the hold rolled back with the failed wallet credit");
      assert((await credits()).length === 0, "no wallet transaction");
      assert((await walletBalance()) === balanceBefore, "wallet escrow balance unchanged");

      // 2. Failure lifted, provider redelivers → hold + credit created once.
      await world.db.execute(`ALTER TABLE wallet_transactions DROP CONSTRAINT j475_block`);
      constraintAdded = false;
      const healed = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(healed.status === 200, `redelivery acked (got ${healed.status})`);
      await world.waitFor(async () => (await holds()).length > 0, 5000, "redelivery creates the missing hold (post-ack)");
      const h = await holds();
      assert(h.length === 1 && h[0].state === "escrow_held", `redelivery created the missing hold (got ${h.length})`);
      assert((await credits()).length === 1, "redelivery created the wallet credit");
      const gross = Math.round(parseFloat(h[0].amount) * 100);
      assert((await walletBalance()) === balanceBefore + gross, `wallet credited exactly the hold (got ${await walletBalance()}, want ${balanceBefore + gross})`);

      // 3. Another redelivery: nothing moves. No new state to poll FOR (the assertion is that nothing
      // changes) — a short settle window lets the replay's post-ack work finish before checking.
      await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      await new Promise((r) => setTimeout(r, 300));
      assert((await holds()).length === 1, "no second hold");
      assert((await credits()).length === 1, "no second credit");
      assert((await walletBalance()) === balanceBefore + gross, "no double credit");
    } finally {
      if (constraintAdded) await world.db.execute(`ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS j475_block`);
      await world.db.update(schema.escrowConfig).set({ custodyMode: originalMode as any }).where(eq(schema.escrowConfig.id, 1));
    }
  },
};
