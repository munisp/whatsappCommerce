/**
 * === W38 money-integrity (Coder A) ===
 * J249 — PAY-2 attempt cap + dead-letter: the sweep verifies first (provider
 * has NO refund), the retry fails, and after the attempt cap is reached the
 * escrow is dead-lettered honestly (flag cleared, alert recorded) instead of
 * retrying forever on every scan.
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";
import { pay } from "../metaMock";

export const journey: Journey = {
  id: "J249",
  name: "PAY-2: sweep attempt cap → honest dead-letter",
  feature: "W38 sla.ts capped refund sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("pay2-dead");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    const payRes = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
    assert(payRes.status === 200, "webhook accepted");

    const [escrow] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    assert(escrow, "escrow exists");

    // Provider truth: NO refund exists, and the provider keeps failing.
    pay.refundVerifyState = "not_found";
    pay.refundPostStatus = 500;

    await world.db.update(schema.escrowTransactions).set({
      metadata: { ...((escrow.metadata ?? {}) as Record<string, unknown>), refundSweepRequired: true, providerRefundOnly: true },
    }).where(eq(schema.escrowTransactions.id, escrow.id));

    const { runSlaScan } = await import("../../server/routers/sla");

    // ── Failed attempts stay flagged and journaled (cap = 5) ────────────
    await runSlaScan();
    let [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    let meta = (esc.metadata ?? {}) as Record<string, unknown>;
    assert(meta.refundSweepRequired === true, "still flagged after a failed attempt (retry next scan)");
    const attempts = await world.db.select().from(schema.refundAttempts)
      .where(and(eq(schema.refundAttempts.orderId, order.orderId), eq(schema.refundAttempts.status, "failed")));
    assert(attempts.length === 1, `failed attempt journaled (got ${attempts.length})`);

    // ── Reach the cap → dead-letter, no further automatic retries ────────
    const amountCents = Math.round(parseFloat(String(escrow.amount)) * 100);
    for (let i = 0; i < 4; i++) {
      await world.db.insert(schema.refundAttempts).values({
        tenantId: TENANT_ID, orderId: order.orderId, provider: "paystack",
        idempotencyKey: `seed-dead-${i}`, amountCents, currency: "NGN", status: "failed",
      });
    }
    const postsBefore = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;
    await runSlaScan();
    const postsAfter = pay.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund")).length;
    assert(postsAfter === postsBefore, "no provider call once the attempt cap is reached");

    [esc] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrow.id)).limit(1);
    meta = (esc.metadata ?? {}) as Record<string, unknown>;
    assert(meta.providerRefundDeadLettered === true, "honest dead-letter marker set");
    assert(meta.refundSweepRequired === false, "sweep stops retrying after dead-letter");
    assert(meta.providerRefundVocabulary === "refund_failed", "honest failed vocabulary");
  },
};
