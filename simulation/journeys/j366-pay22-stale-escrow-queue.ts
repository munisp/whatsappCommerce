/**
 * === W45 money-scheduled (Coder B1) ===
 * J366 — PAY-22: stale-escrow queue. A paid-but-undelivered escrow past its
 * buyer-confirmation deadline is no longer just skipped forever:
 *  1. the buyer gets a "confirm or dispute" prompt (BOTH channels via
 *     sendCustomerText — WA here; telegram-linked buyers route through
 *     channelSender), claimed-before-send with a 24h dedupe marker;
 *  2. once the never-shipped order exceeds the no-ship grace window the
 *     escrow is AUTO-REFUNDED to the buyer (provider leg + honest payment
 *     vocabulary + audit + ops alert);
 *  3. a DELIVERED order still auto-settles (existing behaviour preserved).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

async function paidEscrow(world: World, phone: string, product: string) {
  const schema = await import("../../drizzle/schema");
  await world.grantConsent(phone);
  const order = await createChatOrderViaNlp(world, phone, { items: [{ product, quantity: 1 }] });
  const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: order.total });
  assert(pay.status === 200, `paystack webhook accepted (got ${pay.status})`);
  let escrow: any | null = null;
  await world.waitFor(async () => {
    const [e] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.orderId, order.orderId)).limit(1);
    escrow = e ?? null;
    return !!escrow && escrow.state === "escrow_held";
  }, 10000, "escrow hold created in escrow_held");
  return { order, escrow: escrow! };
}

export const journey: Journey = {
  id: "J366",
  name: "PAY-22: stale-escrow buyer prompt + merchant-no-ship auto-refund",
  feature: "W45 sla scan stale-escrow queue",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { runSlaScan } = await import("../../server/routers/sla");

    // ── A. Never-shipped order, deadline just breached → buyer prompt ────
    const phoneA = world.newPhone("j366-stale");
    const a = await paidEscrow(world, phoneA, "Grilled Chicken");
    await world.db.update(schema.orders).set({ status: "processing" }).where(eq(schema.orders.id, a.order.orderId));
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.escrowTransactions.id, a.escrow.id));

    // ── B. Delivered order, deadline breached → still auto-settles ───────
    const phoneB = world.newPhone("j366-delivered");
    const b = await paidEscrow(world, phoneB, "Jollof Rice");
    await world.db.update(schema.orders).set({ status: "delivered" }).where(eq(schema.orders.id, b.order.orderId));
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.escrowTransactions.id, b.escrow.id));

    const scan1 = await runSlaScan();
    assert(scan1.staleEscrowPrompted >= 1, `buyer prompted (got ${JSON.stringify(scan1)})`);
    const [escA1] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, a.escrow.id));
    assert(escA1.state === "escrow_held", "stale escrow NOT settled and not yet refunded");
    const metaA1 = (escA1.metadata ?? {}) as Record<string, unknown>;
    assert(typeof metaA1.staleEscrowPromptAt === "string", "prompt dedupe marker claimed before send");
    const prompts = world.outbound.findByBody("CONFIRM receipt", phoneA);
    assert(prompts.length >= 1, "buyer received the confirm-or-dispute prompt on their channel");

    // Delivered control settled.
    const [escB1] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, b.escrow.id));
    assert(escB1.state === "settled" || escB1.state === "release_instructed", `delivered order auto-settled (got ${escB1.state})`);

    // Dedupe: an immediate rescan does NOT re-prompt (24h marker).
    const scan1b = await runSlaScan();
    const promptsAfter = world.outbound.findByBody("CONFIRM receipt", phoneA);
    assert(promptsAfter.length === prompts.length, "no double prompt within the dedupe window");
    assert(scan1b.merchantNoShipRefunded === 0, "grace window not elapsed — no refund yet");

    // ── A2. Breach beyond the no-ship grace (72h) → auto-refund ──────────
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() - 100 * 3600_000) })
      .where(eq(schema.escrowTransactions.id, a.escrow.id));
    const scan2 = await runSlaScan();
    assert(scan2.merchantNoShipRefunded >= 1, `merchant-no-ship auto-refunded (got ${JSON.stringify(scan2)})`);
    const [escA2] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, a.escrow.id));
    assert(escA2.state === "refunded", `never-shipped escrow refunded to buyer (got ${escA2.state})`);
    const [ordA2] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, a.order.orderId));
    assert(ordA2.paymentStatus === "refund_initiated", `honest provider vocabulary (got ${ordA2.paymentStatus})`);
    const refundMsgs = world.outbound.findByBody("never shipped", phoneA);
    assert(refundMsgs.length >= 1, "buyer notified of the no-ship refund");
    const audit = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "escrow.merchant_no_ship_auto_refund"));
    assert(audit.some((r) => r.entityId === a.escrow.id), "auto-refund audited");

    // Terminal: a final scan is a no-op for A (already refunded).
    const scan3 = await runSlaScan();
    const [escA3] = await world.db.select().from(schema.escrowTransactions).where(eq(schema.escrowTransactions.id, a.escrow.id));
    assert(escA3.state === "refunded", "terminal — no double refund");
    assert((scan3.merchantNoShipRefunded ?? 0) === 0, "no repeat refund");
  },
};
