/**
 * J595 — the escrow hold created on payment confirmation is atomic and
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
 *   1. the wallet-transaction insert for this order is made to fail → the
 *      webhook still acks 200 (W48 ack-first), NEITHER the hold NOR a wallet
 *      credit exists (no half state), and the event is queued for retry —
 *      Paystack will not redeliver an event we already acked;
 *   2. the failure is lifted and the retry sweep replays it → the hold AND
 *      the wallet credit are created, exactly once;
 *   3. a further Paystack redelivery changes nothing.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J595",
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

      // 1. Make the wallet-transaction write for THIS order fail.
      await world.db.execute(
        `ALTER TABLE wallet_transactions ADD CONSTRAINT j568_block CHECK (order_id IS DISTINCT FROM '${order.orderId}') NOT VALID`,
      );
      constraintAdded = true;
      const { PSP_CONFIRM_RETRY_EVENT, sweepPspConfirmRetries } = await import("../../server/services/payments/pspChargeWebhook");
      const { and } = await import("drizzle-orm");
      const retryRows = () => world.db.select().from(schema.webhookEvents).where(and(
        eq(schema.webhookEvents.eventType, PSP_CONFIRM_RETRY_EVENT),
        eq(schema.webhookEvents.source, "paystack"),
      )).then((rows) => rows.filter((r) => (r.payload as any)?.reference === order.paymentRef));
      const failed = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(failed.status === 200, `webhook acks first (got ${failed.status})`);
      await world.waitFor(async () => (await retryRows()).length === 1, 8000, "failed processing queued for retry");
      assert((await retryRows())[0].status === "failed", `retry row records the failure (got status=${(await retryRows())[0].status})`);
      assert((await holds()).length === 0, "no half state: the hold rolled back with the failed wallet credit");
      assert((await credits()).length === 0, "no wallet transaction");
      assert((await walletBalance()) === balanceBefore, "wallet escrow balance unchanged");

      // 2. Failure lifted, the retry sweep replays the event → hold + credit created once.
      await world.db.execute(`ALTER TABLE wallet_transactions DROP CONSTRAINT j568_block`);
      constraintAdded = false;
      const run = await sweepPspConfirmRetries(world.db as any);
      assert(run.healed >= 1, `retry sweep healed the event (got ${JSON.stringify(run)})`);
      assert((await retryRows())[0].status === "processed", "retry row marked processed");
      const h = await holds();
      assert(h.length === 1 && h[0].state === "escrow_held", `redelivery created the missing hold (got ${h.length})`);
      assert((await credits()).length === 1, "redelivery created the wallet credit");
      const gross = Math.round(parseFloat(h[0].amount) * 100);
      assert((await walletBalance()) === balanceBefore + gross, `wallet credited exactly the hold (got ${await walletBalance()}, want ${balanceBefore + gross})`);

      // 3. A Paystack redelivery (and a second sweep) after the heal: nothing moves.
      const redelivered = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
      assert(redelivered.status === 200, `redelivery acked (got ${redelivered.status})`);
      await new Promise((r) => setTimeout(r, 500)); // post-ack processing
      await sweepPspConfirmRetries(world.db as any);
      assert((await holds()).length === 1, "no second hold");
      assert((await credits()).length === 1, "no second credit");
      assert((await walletBalance()) === balanceBefore + gross, "no double credit");
    } finally {
      if (constraintAdded) await world.db.execute(`ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS j568_block`);
      await world.db.update(schema.escrowConfig).set({ custodyMode: originalMode as any }).where(eq(schema.escrowConfig.id, 1));
    }
  },
};
