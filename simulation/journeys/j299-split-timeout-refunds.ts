/**
 * === W41 (Coder B, UC-3) ===
 * J299 — Split payment timeout: a session that expires before full funding
 * is claimed by the sweep exactly once; every contribution is auto-refunded
 * (WALLET CREDIT default, PSP reversal optional — here the link payer's
 * reversal is requested and the wallet payer is credited), contributors are
 * notified, the order is cancelled, and a second sweep is a no-op.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J299",
  name: "split timeout: sweep auto-refunds contributors (wallet default)",
  feature: "W41 UC-3 48h timeout auto-refund sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const split = await import("../../server/services/splitPayments");
    const wallet = await import("../../server/services/customerWallet");

    const orderId = `j299-${Date.now()}`;
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: `cust-${orderId}`, orderNumber: `ORD-${orderId}`,
      status: "pending", paymentStatus: "unpaid", totalAmount: "2000.00", currency: "NGN",
    }).onConflictDoNothing();

    const waWallet = world.newPhone("w41i");
    const waLink = world.newPhone("w41j");
    for (const p of [waWallet, waLink]) {
      await world.db.insert(schema.customers).values({
        id: `cust-${p}`, tenantId: TENANT_ID, whatsappPhone: p, name: `Split ${p}`,
      }).onConflictDoNothing();
      await world.grantConsent(p);
    }

    const created = await split.createSplitSession(TENANT_ID, orderId, 200000, [waWallet, waLink]);

    // One wallet contribution + one link contribution (partial funding only).
    await wallet.creditWallet(TENANT_ID, waWallet, 100000, "merchant_goodwill", "goodwill:j299");
    const c1 = await split.contributeSplit(created.sessionId, waWallet, 100000, "wallet");
    assert(c1.ok === true, "wallet contribution in");
    assert((await wallet.walletBalance(TENANT_ID, waWallet)) === 0, "wallet spent on the contribution");
    const linkRef = `paylink-j299-${Date.now()}`;
    const c2 = await split.contributeSplit(created.sessionId, waLink, 50000, "link", linkRef);
    assert(c2.ok === true && c2.fullyFunded === false, "partial link contribution in");

    // Expire the session (simulate the 48h timeout arriving).
    await world.db.update(schema.splitPaymentSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.splitPaymentSessions.id, created.sessionId));

    // Sweep: PSP reversal requested for the link payer; wallet payer credited.
    const pspCalls: { reference: string; amountCents: number }[] = [];
    const sweep = await split.sweepExpiredSplitSessions({
      pspRefund: async ({ reference, amountCents }) => { pspCalls.push({ reference, amountCents }); return true; },
    });
    assert(sweep.sessionsRefunded === 1, `one session swept, got ${sweep.sessionsRefunded}`);
    assert(pspCalls.length === 1 && pspCalls[0].reference === linkRef && pspCalls[0].amountCents === 50000,
      `PSP reversal requested for the link contribution: ${JSON.stringify(pspCalls)}`);
    assert((await wallet.walletBalance(TENANT_ID, waWallet)) === 100000,
      "wallet contribution auto-refunded as store credit");

    const [sess] = await world.db.select().from(schema.splitPaymentSessions)
      .where(eq(schema.splitPaymentSessions.id, created.sessionId)).limit(1);
    assert(sess.status === "refunded", `session refunded, got ${sess.status}`);
    assert((sess.participants as any[]).every((p) => p.paidCents === 0 || p.status === "refunded"),
      "every contributor marked refunded");
    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
    assert(ord.status === "cancelled", `unfunded order cancelled, got ${ord.status}`);

    // Refund notice went out to the wallet contributor on WA.
    await world.waitFor(() => world.outbound.toPhone(waWallet).some((c) =>
      JSON.stringify(c).includes("timed out")), 8000, "refund notice on WA");

    // Second sweep: the claimed+refunded session is not picked up again.
    const again = await split.sweepExpiredSplitSessions();
    assert(again.sessionsRefunded === 0 && again.creditsIssued === 0, "re-sweep is a no-op (claim-first)");
    assert((await wallet.walletBalance(TENANT_ID, waWallet)) === 100000, "no double refund");
  },
};
