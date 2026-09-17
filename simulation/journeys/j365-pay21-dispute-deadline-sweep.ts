/**
 * === W45 money-scheduled (Coder B1) ===
 * J365 — PAY-21: dispute merchantResponseDeadline sweep. An open dispute past
 * its merchant-response deadline is ESCALATED (guarded claim, audit, tenant +
 * ops notifications — no money). With auto-resolve config-gated OFF that is
 * terminal for the sweep; with the gate ON and the grace window elapsed, the
 * dispute auto-resolves BUYER-FAVOUR through the hardened refund path
 * (escrow refunded, provider leg, honest order payment status, audited as
 * system:merchant-no-response).
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

async function disputedEscrow(world: World, phone: string) {
  const schema = await import("../../drizzle/schema");
  await world.grantConsent(phone);
  const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
  const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
  assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
  let escrow: any | null = null;
  await world.waitFor(async () => {
    const [e] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    escrow = e ?? null;
    return !!escrow && escrow.state === "escrow_held";
  }, 10000, "escrow hold created in escrow_held");
  const { raiseEscrowDispute } = await import("../../server/services/disputes");
  const dispute = await raiseEscrowDispute(world.db as any, {
    escrowTxId: escrow!.id, orderId: order.orderId, tenantId: TENANT_ID,
    raisedBy: "buyer", reason: "not_received", description: "J365 never arrived",
  });
  return { order, escrow: escrow!, dispute };
}

export const journey: Journey = {
  id: "J365",
  name: "PAY-21: dispute deadline sweep escalates then auto-resolves buyer-favour",
  feature: "W45 dispute merchantResponseDeadline sweep (config-gated, audited)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const savedAutoResolve = process.env.DISPUTE_AUTO_RESOLVE_ENABLED;
    const savedGrace = process.env.DISPUTE_AUTO_RESOLVE_GRACE_HOURS;
    try {
      const phone = world.newPhone("j365-buyer");
      const { order, escrow, dispute } = await disputedEscrow(world, phone);
      // Merchant deadline already missed (1min ago).
      await world.db.update(schema.escrowDisputes)
        .set({ merchantResponseDeadline: new Date(Date.now() - 60_000) })
        .where(eq(schema.escrowDisputes.id, dispute.id));

      // ── 1. Gate OFF: escalate only, NEVER auto-resolve ─────────────────
      process.env.DISPUTE_AUTO_RESOLVE_ENABLED = "false";
      const s1 = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s1.status === 200 && s1.json?.ok === true, `sweep accepted (${JSON.stringify(s1.json)})`);
      assert(s1.json.escalated >= 1, `dispute escalated (got ${JSON.stringify(s1.json)})`);
      assert(s1.json.autoResolveEnabled === false, "gate honestly reported off");
      const [d1] = await world.db.select().from(schema.escrowDisputes).where(eq(schema.escrowDisputes.id, dispute.id));
      assert(d1.status === "escalated", `dispute escalated (got ${d1.status})`);
      assert(d1.escalatedAt, "escalatedAt stamped");
      const [e1] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrow.id));
      assert(e1.state === "dispute_raised", "escrow still frozen — no money moved with gate off");
      const escAudit = await world.db.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.action, "dispute.escalated"), eq(schema.auditLogs.entityId, dispute.id)));
      assert(escAudit.length >= 1, "escalation audited");

      // Idempotent escalate: a second sweep does not re-escalate.
      const s1b = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s1b.json?.escalated === 0, "no double-escalation");

      // ── 2. Gate ON + grace elapsed: auto-resolve buyer-favour ──────────
      process.env.DISPUTE_AUTO_RESOLVE_ENABLED = "true";
      process.env.DISPUTE_AUTO_RESOLVE_GRACE_HOURS = "1";
      await world.db.update(schema.escrowDisputes)
        .set({ merchantResponseDeadline: new Date(Date.now() - 2 * 3600_000) })
        .where(eq(schema.escrowDisputes.id, dispute.id));
      const s2 = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s2.status === 200, "second sweep accepted");
      assert(s2.json?.autoResolvedBuyer >= 1, `auto-resolved buyer-favour (got ${JSON.stringify(s2.json)})`);
      const [d2] = await world.db.select().from(schema.escrowDisputes).where(eq(schema.escrowDisputes.id, dispute.id));
      assert(d2.status === "resolved_buyer", `dispute resolved_buyer (got ${d2.status})`);
      assert(d2.resolution === "full_refund_to_buyer", "resolution is a full refund to the buyer");
      assert(d2.resolvedBy === "system:merchant-no-response", "resolver honestly labelled");
      const [e2] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, escrow.id));
      assert(e2.state === "refunded", `escrow refunded (got ${e2.state})`);
      const [o2] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId));
      assert(o2.status === "refunded", `order refunded (got ${o2.status})`);
      // PSP custody: the provider leg runs → paystack queues refunds in sim.
      assert(o2.paymentStatus === "refund_initiated", `honest provider vocabulary (got ${o2.paymentStatus})`);
      const resAudit = await world.db.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.action, "dispute.auto_resolved_buyer"), eq(schema.auditLogs.entityId, dispute.id)));
      assert(resAudit.length >= 1, "auto-resolution audited");

      // ── 3. Terminal: further sweeps touch nothing ──────────────────────
      const s3 = await world.runCron("/api/scheduled/dispute-deadline-sweep");
      assert(s3.json?.escalated === 0 && s3.json?.autoResolvedBuyer === 0, "terminal — replay is a no-op");
    } finally {
      if (savedAutoResolve === undefined) delete process.env.DISPUTE_AUTO_RESOLVE_ENABLED;
      else process.env.DISPUTE_AUTO_RESOLVE_ENABLED = savedAutoResolve;
      if (savedGrace === undefined) delete process.env.DISPUTE_AUTO_RESOLVE_GRACE_HOURS;
      else process.env.DISPUTE_AUTO_RESOLVE_GRACE_HOURS = savedGrace;
    }
  },
};
