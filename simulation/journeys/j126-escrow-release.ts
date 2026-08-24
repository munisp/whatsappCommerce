/**
 * J126 — Escrow hold → SLA auto-release (PSP custody):
 * a chat order paid via the REAL paystack webhook creates an escrow hold
 * (real paymentConfirm path, integer-minor-units split); switching custody
 * to PSP and breaching the buyer-confirm deadline lets the REAL SLA scan
 * (runSlaScan → settleEscrowAtomic) settle the escrow atomically: merchant
 * wallet credited net, platform fee wallet credited fee, and
 * fee + net == gross conserved end to end.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J126",
  name: "escrow hold → SLA auto-release",
  feature: "settleEscrowAtomic + wallet credit conservation",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("escrow");
    await world.grantConsent(phone);

    // ── 1. Real chat order + real paystack webhook → escrow hold ────────
    const order = await createChatOrderViaNlp(world, phone, {
      items: [{ product: "Jollof Rice", quantity: 1 }, { product: "Grilled Chicken", quantity: 1 }],
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
    assert(escrow, "escrow row exists");

    // Integer-minor-units split: fee + net == gross, exactly.
    const gross = Math.round(parseFloat(escrow.amount) * 100);
    const fee = Math.round(parseFloat(escrow.platformFee) * 100);
    const net = Math.round(parseFloat(escrow.netMerchantAmount) * 100);
    assert(fee + net === gross, `split conserves gross (fee ${fee} + net ${net} != gross ${gross})`);
    assert(fee > 0, "platform fee charged");

    // ── 2. PSP custody + breached deadline → SLA auto-release ───────────
    await world.db.update(schema.escrowConfig)
      .set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    try {
      await world.db.update(schema.escrowTransactions)
        .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
        .where(eq(schema.escrowTransactions.id, escrow.id));
      // W30 (verify-v1 #6): the SLA scan now refuses to auto-release escrows
      // whose order is not delivered — simulate fulfilment so this escrow is
      // legitimately releasable.
      await world.db.update(schema.orders)
        .set({ status: "delivered" })
        .where(eq(schema.orders.id, order.orderId));

      const walletBefore = await world.db.select().from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
      const availBefore = walletBefore[0] ? parseFloat(walletBefore[0].availableBalance) : 0;

      const { runSlaScan } = await import("../../server/routers/sla");
      const scan = await runSlaScan();
      assert(scan.settled >= 1, `SLA scan settled the overdue escrow (got ${scan.settled})`);

      const [after] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
      assert(after.state === "settled", `escrow settled (got ${after.state})`);
      assert(after.settledAt, "settledAt stamped");
      assert(after.merchantWalletTxId, "merchant wallet tx linked");

      // Merchant wallet credited the NET amount; fee went to the platform.
      const [wallet] = await world.db.select().from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
      const availAfter = parseFloat(wallet.availableBalance);
      assert(
        Math.round(availAfter * 100) - Math.round(availBefore * 100) === net,
        `merchant wallet +net (${availBefore} → ${availAfter}, expected +${net / 100})`,
      );

      const walletTxs = await world.db.select().from(schema.walletTransactions)
        .where(eq(schema.walletTransactions.escrowTxId, escrow.id));
      const release = walletTxs.find((t) => t.type === "escrow_release");
      const feeTx = walletTxs.find((t) => t.type === "fee_deduction");
      assert(release, "escrow_release wallet ledger entry recorded");
      assert(Math.round(parseFloat(release!.amount) * 100) === net, "release entry == net");
      assert(feeTx, "fee_deduction ledger entry recorded");
      assert(Math.round(parseFloat(feeTx!.amount) * 100) === fee, "fee entry == fee");

      // Idempotence: a second scan must NOT settle again or re-credit.
      const scan2 = await runSlaScan();
      const [final] = await world.db.select().from(schema.merchantWallets)
        .where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
      assert(
        Math.round(parseFloat(final.availableBalance) * 100) === Math.round(availAfter * 100),
        "second scan does not double-credit the merchant wallet",
      );
      assert(scan2.settled === 0, "second scan settles nothing");
    } finally {
      // Restore the seeded custody mode so later journeys see the default.
      await world.db.update(schema.escrowConfig)
        .set({ custodyMode: "pssp" })
        .where(eq(schema.escrowConfig.id, 1));
    }
  },
};
