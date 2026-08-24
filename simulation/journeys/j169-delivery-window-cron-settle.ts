/**
 * J169 — W30 buyer-protection window reset on delivery paths (verify-v1 #14)
 * + escrow auto-confirm cron settles atomically WITH the platform fee leg
 * (verify-v1 #13).
 *
 * Part 1: the logistics simulate-delivery path advances escrow_held →
 * delivery_confirmed through the SHARED helper — the buyerConfirmDeadline is
 * reset from the delivery moment (previously left running from payment time,
 * so the protection window could be ~zero).
 *
 * Part 2: the /api/scheduled/escrow-auto-confirm cron delegates to
 * settleEscrowAtomic: one transaction (flip + merchant net credit + fee leg)
 * — the platform fee wallet is credited, and fee + net == gross is conserved.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J169",
  name: "delivery window reset + cron settle atomic with fee leg",
  feature: "W30 confirmEscrowDelivery helper + auto-confirm cron",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    try {
      const phone = world.newPhone("window-cron");
      await world.grantConsent(phone);
      const order = await createChatOrderViaNlp(world, phone, {
        items: [{ product: "Jollof Rice", quantity: 1 }, { product: "Grilled Chicken", quantity: 1 }],
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

      // ── Part 1: delivery via the logistics path resets the window ──────
      // Stale the deadline to the past (as if payment→delivery took days)…
      await world.db.update(schema.escrowTransactions)
        .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
        .where(eq(schema.escrowTransactions.id, escrow.id));
      // …then deliver via a real shipment + the simulate-delivery procedure.
      const shipmentId = crypto.randomUUID();
      await world.db.insert(schema.logisticsShipments).values({
        id: shipmentId, tenantId: TENANT_ID, orderId: order.orderId,
        escrowTxId: escrow.id, provider: "shipbubble", status: "out_for_delivery",
        trackingId: `TRK-J169-${shipmentId.slice(0, 8)}`,
      });
      const tenant = await tenantCaller(TENANT_ID);
      await tenant.logistics.simulateDelivery({ shipmentId, status: "delivered" });

      const [escDel] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(escDel.state === "delivery_confirmed", `escrow delivery_confirmed (got ${escDel.state})`);
      const deadlineMs = new Date(escDel.buyerConfirmDeadline!).getTime();
      // Window reset from DELIVERY time (24h default) — not the stale past.
      assert(deadlineMs > Date.now() + 20 * 3600_000,
        `buyer-protection deadline reset from delivery (got ${escDel.buyerConfirmDeadline})`);

      // ── Part 2: auto-confirm cron settles atomically with the fee leg ──
      await world.db.update(schema.escrowTransactions)
        .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
        .where(eq(schema.escrowTransactions.id, escrow.id));

      const gross = Math.round(parseFloat(escrow.amount) * 100);
      const fee = Math.round(parseFloat(escrow.platformFee) * 100);
      const net = Math.round(parseFloat(escrow.netMerchantAmount) * 100);
      assert(fee + net === gross, "fee + net == gross");

      const cron = await world.runCron("/api/scheduled/escrow-auto-confirm");
      assert(cron.status === 200, `cron accepted (got ${cron.status})`);
      assert((cron.json?.confirmed ?? 0) >= 1, `cron settled >= 1 escrow (got ${JSON.stringify(cron.json)})`);

      const [escSettled] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(escSettled.state === "settled", `escrow settled by cron (got ${escSettled.state})`);
      assert(escSettled.merchantWalletTxId, "merchant wallet tx linked");

      // Both legs recorded: merchant net release + platform fee deduction.
      const walletTxs = await world.db.select().from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.escrowTxId, escrow.id));
      const release = walletTxs.find((t) => t.type === "escrow_release");
      const feeTx = walletTxs.find((t) => t.type === "fee_deduction");
      assert(release, "escrow_release leg recorded");
      assert(Math.round(parseFloat(release!.amount) * 100) === net, "release leg == net");
      assert(feeTx, "platform fee leg recorded (fee collected)");
      assert(Math.round(parseFloat(feeTx!.amount) * 100) === fee, "fee leg == fee");

      // Platform fee wallet actually holds the fee.
      const [feeWallet] = await world.db.select().from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.id, "platform-fee-wallet")).limit(1);
      assert(feeWallet, "platform fee wallet exists");
      assert(parseFloat(feeWallet.availableBalance) * 100 >= fee, "platform fee wallet credited");

      // Idempotent: a second cron run settles nothing more.
      const cron2 = await world.runCron("/api/scheduled/escrow-auto-confirm");
      const [escFinal] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(escFinal.state === "settled", "escrow remains settled after cron replay");
      const walletTxs2 = await world.db.select().from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.escrowTxId, escrow.id));
      assert(walletTxs2.filter((t) => t.type === "escrow_release").length === 1, "no double credit on cron replay");
    } finally {
      await world.db.update(schema.escrowConfig).set({ custodyMode: "pssp" })
        .where(eq(schema.escrowConfig.id, 1));
    }
  },
};
