/**
 * J88 — Chat order with cash on delivery → rider assignment → out for
 * delivery → delivered → rider confirms cash via WhatsApp reply
 * (RIDER_CONFIRM <orderNumber>) → merchant settles.
 *
 * Runs the REAL webhook/NLP checkout path ("2 cash on delivery" at the
 * fulfillment step) plus the REAL rider-reply handler in the webhook.
 */
import { TENANT_ID, assert, assertIncludes, bodyText, latestOrderForPhone, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J88",
  name: "COD chat order → rider cash → settled",
  feature: "cod state machine + RIDER_CONFIRM reply",
  async run(world) {
    const phone = world.newPhone("a");
    const rider = world.newPhone("rider");
    await world.grantConsent(phone);
    await world.grantConsent(rider);
    await world.patchTenantSettings({ codRiderPhones: [rider] });

    // ── Chat order choosing cash on delivery at the fulfillment step ──────
    await nlpAddToCart(world, phone, "2 jollof rice j88", [{ product: "Jollof Rice", quantity: 2 }]);
    await nlpConfirm(world, phone, "confirm my order j88");
    await world.text(phone, "2 cash on delivery");
    await world.text(phone, "12 Marina Road, Lagos Island, Lagos");

    const orderMsg = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderMsg, "Cash on delivery", "summary offers cash on delivery");
    assert(!orderMsg.includes("checkout.paystack.com"), "no payment link for COD");

    const order = await latestOrderForPhone(world, phone);
    assert(order, "chat COD order created");
    assert(order.codState === "cod_pending", `order enters cod_pending (got ${order.codState})`);
    assert((order.metadata as any)?.paymentMethod === "cod", "metadata paymentMethod cod");
    assert(order.paymentStatus === "unpaid", "COD order starts unpaid");

    const schema = await import("../../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const [entry] = await world.db
      .select().from(schema.codEvents)
      .where(and(eq(schema.codEvents.orderId, order.id), eq(schema.codEvents.toState, "cod_pending")))
      .limit(1);
    assert(entry, "cod_pending entry event recorded");

    // ── Dispatch: assign rider → out for delivery → delivered ────────────
    const { transitionCod, settleCod, orderPaymentSummary } = await import("../../server/services/codFlow");
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "rider_assigned", actor: "dispatcher" });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "out_for_delivery", actor: `rider:${rider}` });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "delivered_pending_cash", actor: `rider:${rider}` });

    // Illegal transition is rejected (no silent no-op).
    let illegalThrew = false;
    try {
      await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "settled", actor: "dispatcher" });
    } catch (e: any) {
      illegalThrew = e?.name === "CodTransitionError";
    }
    assert(illegalThrew, "delivered_pending_cash → settled rejected");

    // ── Rider confirms cash collection via WhatsApp reply ─────────────────
    await world.text(rider, `RIDER_CONFIRM ${order.orderNumber}`);
    const riderReply = bodyText(world.outbound.lastOfType("text", rider));
    assertIncludes(riderReply, "fully collected", "rider gets collection confirmation");

    const after = await latestOrderForPhone(world, phone);
    assert(after.codState === "cash_collected", `cash_collected (got ${after.codState})`);
    assert(after.paymentStatus === "completed", "order marked paid on collection");

    // Replay the same rider reply → no double money row.
    await world.text(rider, `RIDER_CONFIRM ${order.orderNumber}`);
    const replayReply = bodyText(world.outbound.lastOfType("text", rider));
    assertIncludes(replayReply, "already recorded", "replay is idempotent");
    const cashRows = await world.db
      .select().from(schema.paymentTransactions)
      .where(and(eq(schema.paymentTransactions.orderId, order.id), eq(schema.paymentTransactions.provider, "cod")));
    assert(cashRows.length === 1, `exactly one COD cash row (got ${cashRows.length})`);

    // ── Settlement: once only ─────────────────────────────────────────────
    const s1 = await settleCod(world.db, { tenantId: TENANT_ID, orderId: order.id, actor: "merchant" });
    assert(s1.settled && !s1.replay, "first settle applies");
    const s2 = await settleCod(world.db, { tenantId: TENANT_ID, orderId: order.id, actor: "merchant" });
    assert(s2.replay, "settle replay is a no-op");
    const final = await latestOrderForPhone(world, phone);
    assert(final.codState === "settled", "order settled");

    const summary = await orderPaymentSummary(world.db, TENANT_ID, order.id);
    assert(summary.status === "paid" && summary.remaining === 0, "payment summary fully paid");

    // Reconciliation picks the collection up with zero variance.
    const { codReconciliation } = await import("../../server/services/codFlow");
    const rep = await codReconciliation(world.db, TENANT_ID, { windowDays: 1 });
    const today = rep.days[rep.days.length - 1];
    assert(today.collected >= summary.total, "today's collected includes the order");
    assert(!rep.unsettled.some((u) => u.orderId === order.id), "settled order not in aging list");
  },
};
