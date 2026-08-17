/**
 * J90 — Partial cash collection: rider confirms PART of the cash via
 * WhatsApp reply → remaining balance tracked (order stays
 * delivered_pending_cash, summary partial) → second reply completes the
 * balance → cash_collected → settled. Reconciliation shows the collection.
 */
import { TENANT_ID, assert, assertIncludes, bodyText, latestOrderForPhone, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J90",
  name: "COD partial cash → balance → completion",
  feature: "partial-payment tracking + reconciliation",
  async run(world) {
    const phone = world.newPhone("a");
    const rider = world.newPhone("rider");
    await world.grantConsent(phone);
    await world.grantConsent(rider);
    await world.patchTenantSettings({ codRiderPhones: [rider] });

    await nlpAddToCart(world, phone, "2 jollof rice and 1 chicken j90", [
      { product: "Jollof Rice", quantity: 2 },
      { product: "Grilled Chicken", quantity: 1 },
    ]);
    await nlpConfirm(world, phone, "confirm my order j90");
    await world.text(phone, "1 cash on delivery"); // pickup + COD → ₦8,000 total
    const orderMsg = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderMsg, "Cash on pickup", "pickup COD summary");
    assertIncludes(orderMsg, "₦8,000.00", "total ₦8,000");

    const order = await latestOrderForPhone(world, phone);
    assert(order?.codState === "cod_pending", "order in COD flow");
    assert(Number(order.totalAmount) === 8000, "total 8000");

    const { transitionCod, orderPaymentSummary, settleCod } = await import("../../server/services/codFlow");
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "rider_assigned", actor: "dispatcher" });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "out_for_delivery", actor: `rider:${rider}` });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "delivered_pending_cash", actor: `rider:${rider}` });

    // ── Rider collects only ₦5,000 of the ₦8,000 ─────────────────────────
    await world.text(rider, `RIDER_CONFIRM ${order.orderNumber} 5000`);
    const partialReply = bodyText(world.outbound.lastOfType("text", rider));
    assertIncludes(partialReply, "Remaining balance: 3000.00", "partial confirmation shows balance");

    let cur = await latestOrderForPhone(world, phone);
    assert(cur.codState === "delivered_pending_cash", "still awaiting the balance");
    let sum = await orderPaymentSummary(world.db, TENANT_ID, order.id);
    assert(sum.status === "partial", `summary partial (got ${sum.status})`);
    assert(sum.totalPaid === 5000 && sum.remaining === 3000, "5000 paid / 3000 remaining");

    // Unsettled aging lists the open balance.
    const { codReconciliation } = await import("../../server/services/codFlow");
    const mid = await codReconciliation(world.db, TENANT_ID, { windowDays: 1 });
    const aging = mid.unsettled.find((u) => u.orderId === order.id);
    assert(aging, "partial order in aging list");
    assert(aging!.collectedAmount === 5000 && aging!.remaining === 3000, "aging tracks the balance");

    // ── Rider collects the remaining ₦3,000 later ────────────────────────
    await world.text(rider, `RIDER_CONFIRM ${order.orderNumber} 3000`);
    const doneReply = bodyText(world.outbound.lastOfType("text", rider));
    assertIncludes(doneReply, "fully collected", "completion confirmation");

    cur = await latestOrderForPhone(world, phone);
    assert(cur.codState === "cash_collected", "cash_collected after balance paid");
    sum = await orderPaymentSummary(world.db, TENANT_ID, order.id);
    assert(sum.status === "paid" && sum.totalPaid === 8000, "summary fully paid (2 records)");
    const schema = await import("../../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const cashRows = await world.db
      .select().from(schema.paymentTransactions)
      .where(and(eq(schema.paymentTransactions.orderId, order.id), eq(schema.paymentTransactions.provider, "cod")));
    assert(cashRows.length === 2, `two cash records (got ${cashRows.length})`);

    const st = await settleCod(world.db, { tenantId: TENANT_ID, orderId: order.id, actor: "merchant" });
    assert(st.settled && !st.replay, "settled");

    const rep = await codReconciliation(world.db, TENANT_ID, { windowDays: 1 });
    const today = rep.days[rep.days.length - 1];
    assert(today.expected >= 8000 && today.collected >= 8000, "reconciliation day shows expected + collected");
  },
};
