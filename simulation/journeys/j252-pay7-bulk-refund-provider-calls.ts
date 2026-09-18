/**
 * === W38 money-integrity (Coder A) ===
 * J252 — PAY-7 bulk refund honesty (happy path): bulkUpdateState refund on a
 * PSP-custody escrow calls the REAL provider refund per escrow and reports
 * the honest status ("refund_initiated" while the provider queues) — never
 * "refunded" without money movement.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, adminCaller } from "./helpers";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J252",
  name: "PAY-7: bulk refund executes the provider refund per escrow",
  feature: "W38 escrow.bulkUpdateState provider refund path",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay7-bulk");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, "webhook accepted");

    const [escrow] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    assert(escrow, "escrow exists");
    // PSP custody: the platform holds the buyer's money at the provider.
    await world.db.update(schema.escrowTransactions).set({ custodyMode: "psp" })
      .where(eq(schema.escrowTransactions.id, escrow.id));

    const postsBefore = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;
    const admin = await adminCaller();
    const res = await admin.escrow.bulkUpdateState({ escrowIds: [escrow.id], action: "refund", reason: "J252 bulk refund honesty" });
    assert(res.results.length === 1 && res.results[0].success === true, `bulk refund succeeded (got ${JSON.stringify(res.results)})`);
    // Paystack queues refunds — the honest state is refund_initiated, NEVER "refunded".
    assert(res.results[0].newState === "refund_initiated", `honest newState (got ${res.results[0].newState})`);

    const posts = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund"));
    assert(posts.length === postsBefore + 1, "provider refund API actually called");
    assert(posts.some((c) => c.body?.transaction === order.paymentRef), "provider refund targets the original payment reference");

    const [ord] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    assert(ord.paymentStatus === "refund_initiated", `order honestly refund_initiated (got ${ord.paymentStatus})`);
    const [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    assert(esc.state === "refunded", `internal escrow refunded (got ${esc.state})`);
    const meta = (esc.metadata ?? {}) as Record<string, unknown>;
    assert(meta.refundSweepRequired !== true, "no sweep needed when the provider leg succeeds");
  },
};
