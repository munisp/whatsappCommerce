// === W54 disputes ===
/**
 * J548 — DISP-3: merchantRespond action.
 *  1. Tenant merchant responds to an OPEN dispute inside the deadline:
 *     status open → under_review (the previously-dead enum value), the note
 *     lands on merchantEvidence, metadata.merchantRespondedAt is stamped for
 *     the DISP-6 sweep, an evidence token is issued, the response is audited
 *     and the buyer is notified (WA).
 *  2. A second respond is a CONFLICT (guarded claim — exactly once).
 *  3. A respond after merchantResponseDeadline is a CONFLICT (the escalation
 *     sweep owns the dispute from there).
 */
import { eq, and } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, tenantCaller, expectTrpcError } from "./helpers";

async function disputedOrder(world: World, phone: string, tag: string) {
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
    raisedBy: "buyer", reason: "damaged", description: `${tag} arrived damaged`,
  });
  return { order, dispute };
}

export const journey: Journey = {
  id: "J548",
  name: "DISP-3: merchantRespond → under_review, note/evidence/audit/buyer notify, guards",
  feature: "W54 merchant dispute respond action",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const merchant = await tenantCaller(TENANT_ID);

    // ── 1. happy path ─────────────────────────────────────────────────────
    const phone = world.newPhone("j548-buyer");
    const { dispute } = await disputedOrder(world, phone, "J548");
    const buyerBase = world.outbound.toPhone(phone).length;
    const res = await merchant.escrowDispute.merchantRespond({
      disputeId: dispute.id,
      note: "Tracking shows delivery on Tuesday — checking with the courier.",
      generateEvidenceToken: true,
    });
    assert(res.dispute.status === "under_review", `status under_review (got ${res.dispute.status})`);
    assert(res.evidence?.portalUrl?.startsWith("/evidence/"), "evidence token issued with portal URL");
    const [d1] = await world.db.select().from(schema.escrowDisputes)
      .where(eq(schema.escrowDisputes.id, dispute.id));
    assert((d1.merchantEvidence as any)?.note?.includes("Tracking shows delivery"), "note attached to merchantEvidence");
    assert(typeof (d1.metadata as any)?.merchantRespondedAt === "string", "merchantRespondedAt stamped for the DISP-6 sweep");
    const tokens = await world.db.select().from(schema.disputeEvidenceTokens)
      .where(eq(schema.disputeEvidenceTokens.disputeId, dispute.id));
    assert(tokens.length === 1, `evidence token row persisted (got ${tokens.length})`);
    const audits = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "dispute.merchant_responded"), eq(schema.auditLogs.entityId, dispute.id)));
    assert(audits.length >= 1, "merchant response audited");
    await world.waitFor(
      () => world.outbound.toPhone(phone).length > buyerBase,
      10000, "buyer merchant-responded notice");
    const buyerText = world.outbound.toPhone(phone).slice(buyerBase).map((c) => bodyText(c)).join("\n").toLowerCase();
    assert(buyerText.includes("merchant responded") || buyerText.includes("responded"),
      `buyer notice names the merchant response (got ${buyerText.slice(0, 200)})`);

    // ── 2. exactly-once guard ─────────────────────────────────────────────
    await expectTrpcError(
      merchant.escrowDispute.merchantRespond({ disputeId: dispute.id, note: "second response" }),
      "CONFLICT", "second respond rejected");

    // ── 3. deadline interplay: past-deadline respond is a CONFLICT ────────
    const phone2 = world.newPhone("j548-late");
    const { dispute: late } = await disputedOrder(world, phone2, "J548-late");
    await world.db.update(schema.escrowDisputes)
      .set({ merchantResponseDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.escrowDisputes.id, late.id));
    await expectTrpcError(
      merchant.escrowDispute.merchantRespond({ disputeId: late.id, note: "too late" }),
      "CONFLICT", "late respond rejected");
    const [d2] = await world.db.select().from(schema.escrowDisputes)
      .where(eq(schema.escrowDisputes.id, late.id));
    assert(d2.status === "open", "late dispute still open for the escalation sweep");
  },
};
