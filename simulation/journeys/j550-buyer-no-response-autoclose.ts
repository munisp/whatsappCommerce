// === W54 disputes ===
/**
 * J550 — DISP-6: buyer no-response auto-close.
 *  1. Merchant responds (under_review) and the buyer stays idle past
 *     DISPUTE_BUYER_AUTOCLOSE_DAYS → the sweep releases the escrow to the
 *     merchant through the atomic settle path, claims the dispute
 *     under_review → resolved_merchant (resolution no_action, resolver
 *     'system:buyer-no-response'), audits, and notifies BOTH parties.
 *  2. Buyer still inside the window → untouched.
 *  3. Config gate OFF → the auto-close leg is inert.
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller } from "./helpers";

async function underReviewDispute(world: World, phone: string, tag: string) {
  const schema = await import("../../drizzle/schema");
  await world.grantConsent(phone);
  const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
  const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
  assert(pay.status === 200, `${tag}: webhook accepted (got ${pay.status})`);
  let escrow: any | null = null;
  await world.waitFor(async () => {
    const [e] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    escrow = e ?? null;
    return !!escrow && escrow.state === "escrow_held";
  }, 10000, `${tag}: escrow hold`);
  const { raiseEscrowDispute } = await import("../../server/services/disputes");
  const dispute = await raiseEscrowDispute(world.db as any, {
    escrowTxId: escrow!.id, orderId: order.orderId, tenantId: TENANT_ID,
    raisedBy: "buyer", reason: "not_received", description: `${tag} dispute`,
  });
  const merchant = await tenantCaller(TENANT_ID);
  await merchant.escrowDispute.merchantRespond({ disputeId: dispute.id, note: `${tag} merchant response` });
  return { order, escrow: escrow!, dispute };
}

export const journey: Journey = {
  id: "J550",
  name: "DISP-6: buyer no-response auto-close releases escrow to merchant (config-gated)",
  feature: "W54 dispute buyer-no-response auto-close sweep leg",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const savedDays = process.env.DISPUTE_BUYER_AUTOCLOSE_DAYS;
    const savedGate = process.env.DISPUTE_BUYER_AUTOCLOSE_ENABLED;
    try {
      process.env.DISPUTE_BUYER_AUTOCLOSE_DAYS = "7";

      // ── 1. idle buyer → auto-close merchant-favour ──────────────────────
      const phone = world.newPhone("j550-buyer");
      const { order, escrow, dispute } = await underReviewDispute(world, phone, "J550");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600_000);
      await world.db.update(schema.escrowDisputes)
        .set({ metadata: { merchantRespondedAt: eightDaysAgo.toISOString() }, updatedAt: eightDaysAgo })
        .where(eq(schema.escrowDisputes.id, dispute.id));
      const buyerBase = world.outbound.toPhone(phone).length;
      const s1 = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s1.status === 200, `sweep accepted (got ${s1.status})`);
      assert(s1.json?.autoClosedBuyerIdle >= 1, `auto-close ran (got ${JSON.stringify(s1.json)})`);
      const [d1] = await world.db.select().from(schema.escrowDisputes)
        .where(eq(schema.escrowDisputes.id, dispute.id));
      assert(d1.status === "resolved_merchant", `resolved merchant-favour (got ${d1.status})`);
      assert(d1.resolution === "no_action", `resolution no_action (got ${d1.resolution})`);
      assert(d1.resolvedBy === "system:buyer-no-response", `resolver honestly labelled (got ${d1.resolvedBy})`);
      const [e1] = await world.db.select().from(schema.escrowTransactions)
        .where(eq(schema.escrowTransactions.id, escrow.id));
      assert(e1.state === "settled" || e1.state === "release_instructed",
        `escrow released via the settle path (got ${e1.state})`);
      const [o1] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
      assert(o1.paymentStatus === "completed", `order payment completed (got ${o1.paymentStatus})`);
      const audits = await world.db.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.action, "dispute.auto_closed_buyer_idle"), eq(schema.auditLogs.entityId, dispute.id)));
      assert(audits.length >= 1, "auto-close audited");
      await world.waitFor(
        () => world.outbound.toPhone(phone).length > buyerBase,
        10000, "buyer auto-close notice");
      const buyerText = world.outbound.toPhone(phone).slice(buyerBase).map((c) => bodyText(c)).join("\n").toLowerCase();
      assert(buyerText.includes("dispute") && buyerText.includes("merchant"),
        `buyer notice states the outcome (got ${buyerText.slice(0, 200)})`);

      // Replay safety: terminal rows are never re-processed.
      const s1b = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s1b.json?.autoClosedBuyerIdle === 0, "replay is a no-op");

      // ── 2. buyer inside the window → untouched ──────────────────────────
      const phone2 = world.newPhone("j550-fresh");
      const { dispute: fresh } = await underReviewDispute(world, phone2, "J550-fresh");
      const s2 = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s2.status === 200, "sweep accepted");
      const [d2] = await world.db.select().from(schema.escrowDisputes)
        .where(eq(schema.escrowDisputes.id, fresh.id));
      assert(d2.status === "under_review", "fresh under_review dispute untouched inside the window");

      // ── 3. gate OFF → inert ─────────────────────────────────────────────
      process.env.DISPUTE_BUYER_AUTOCLOSE_ENABLED = "false";
      const nineDaysAgo = new Date(Date.now() - 9 * 24 * 3600_000);
      await world.db.update(schema.escrowDisputes)
        .set({ metadata: { merchantRespondedAt: nineDaysAgo.toISOString() }, updatedAt: nineDaysAgo })
        .where(eq(schema.escrowDisputes.id, fresh.id));
      const s3 = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s3.json?.autoClosedBuyerIdle === 0, `gate off = no auto-close (got ${JSON.stringify(s3.json)})`);
      const [d3] = await world.db.select().from(schema.escrowDisputes)
        .where(eq(schema.escrowDisputes.id, fresh.id));
      assert(d3.status === "under_review", "gate-off dispute left under_review");
    } finally {
      if (savedDays === undefined) delete process.env.DISPUTE_BUYER_AUTOCLOSE_DAYS;
      else process.env.DISPUTE_BUYER_AUTOCLOSE_DAYS = savedDays;
      if (savedGate === undefined) delete process.env.DISPUTE_BUYER_AUTOCLOSE_ENABLED;
      else process.env.DISPUTE_BUYER_AUTOCLOSE_ENABLED = savedGate;
    }
  },
};
