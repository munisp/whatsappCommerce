/**
 * J166 — W30 SLA scan order-status guard (verify-v1 #6):
 * an overdue escrow whose order was CANCELLED is auto-REFUNDED to the buyer
 * (never released to the merchant), and an overdue escrow whose order is not
 * delivered is SKIPPED + alerted — the old scan paid merchants for unshipped
 * and cancelled orders once the payment-time deadline elapsed.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess } from "./helpers";

async function paidEscrow(world: World, phone: string, items: { product: string; quantity: number }[]) {
  const schema = await import("../../drizzle/schema");
  await world.grantConsent(phone);
  const order = await createChatOrderViaNlp(world, phone, { items });
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
  return { order, escrow: escrow! };
}

export const journey: Journey = {
  id: "J166",
  name: "SLA scan: cancelled→refund, undelivered→skip",
  feature: "W30 runSlaScan order-status guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { runSlaScan } = await import("../../server/routers/sla");

    // ── A. Paid order, then CANCELLED in DB with an overdue deadline ─────
    const a = await paidEscrow(world, world.newPhone("sla-cancel"), [
      { product: "Jollof Rice", quantity: 1 },
    ]);
    await world.db.update(schema.orders)
      .set({ status: "cancelled" })
      .where(eq(schema.orders.id, a.order.orderId));
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.escrowTransactions.id, a.escrow.id));

    // ── B. Paid order still processing (undelivered), overdue deadline ───
    const b = await paidEscrow(world, world.newPhone("sla-undelivered"), [
      { product: "Grilled Chicken", quantity: 1 },
    ]);
    await world.db.update(schema.escrowTransactions)
      .set({ buyerConfirmDeadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.escrowTransactions.id, b.escrow.id));

    const scan = await runSlaScan();

    // A: cancelled order → escrow REFUNDED, order payment refunded, never settled.
    const [escA] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, a.escrow.id)).limit(1);
    assert(escA.state === "refunded", `cancelled-order escrow refunded (got ${escA.state})`);
    const [ordA] = await world.db.select().from(schema.orders)
      .where(eq(schema.orders.id, a.order.orderId)).limit(1);
    assert(ordA.paymentStatus === "refunded", `cancelled order payment refunded (got ${ordA.paymentStatus})`);
    assert(scan.refunded >= 1, `scan reports refunded >= 1 (got ${scan.refunded})`);

    // B: undelivered order → escrow UNTOUCHED (still escrow_held), skipped.
    const [escB] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, b.escrow.id)).limit(1);
    assert(escB.state === "escrow_held", `undelivered escrow NOT settled (got ${escB.state})`);
    assert(scan.skippedUndelivered >= 1, `scan reports skippedUndelivered >= 1 (got ${scan.skippedUndelivered})`);
    // Cleanup: refund B's escrow so later journeys are unaffected.
    await world.db.update(schema.orders).set({ status: "cancelled" })
      .where(eq(schema.orders.id, b.order.orderId));
  },
};
