/**
 * === W38 money-integrity (Coder A) ===
 * J253 — PAY-7 bulk refund honesty (failure path): when the provider refund
 * FAILS during a bulk refund, the order is honestly "refund_pending" and the
 * escrow is flagged for the SLA sweep — which later executes the provider
 * refund (verify-first) and flips the order to "refund_initiated". Money is
 * never claimed refunded before it moves.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, adminCaller } from "./helpers";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J253",
  name: "PAY-7: failed bulk refund → refund_pending + sweep executes it",
  feature: "W38 escrow.bulkUpdateState refund_pending + sweep handoff",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay7-pend");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, "webhook accepted");

    const [escrow] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    assert(escrow, "escrow exists");
    await world.db.update(schema.escrowTransactions).set({ custodyMode: "psp" })
      .where(eq(schema.escrowTransactions.id, escrow.id));

    // ── Provider down → honest refund_pending + sweep flag ───────────────
    pay.refundPostStatus = 500;
    const admin = await adminCaller();
    const res = await admin.escrow.bulkUpdateState({ escrowIds: [escrow.id], action: "refund", reason: "J253 bulk refund failure honesty" });
    assert(res.results[0]?.success === true, "internal refund done");
    assert(res.results[0]?.newState === "refund_pending", `honest refund_pending (got ${res.results[0]?.newState})`);

    let [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(ord.paymentStatus === "refund_pending", `order refund_pending (got ${ord.paymentStatus})`);
    let [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    let meta = (esc.metadata ?? {}) as Record<string, unknown>;
    assert(meta.refundSweepRequired === true && meta.providerRefundOnly === true, "escrow flagged for the refund sweep");

    // ── Provider back → sweep (verify-first: no existing refund) executes ──
    pay.refundPostStatus = null;
    const { runSlaScan } = await import("../../server/routers/sla");
    await runSlaScan();

    [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(ord.paymentStatus === "refund_initiated", `sweep executed the provider refund (got ${ord.paymentStatus})`);
    [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    meta = (esc.metadata ?? {}) as Record<string, unknown>;
    assert(meta.refundSweepRequired === false, "sweep flag cleared");
    assert(meta.providerRefundVocabulary === "refund_initiated", `honest vocabulary (got ${meta.providerRefundVocabulary})`);
    const posts = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund"));
    assert(posts.length >= 2, "failed attempt + sweep retry both hit the provider");
  },
};
