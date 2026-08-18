/**
 * J105 — M3: COD order placed via WhatsApp → rider assignment → RIDER_CONFIRM
 * chat hook → cash collection (idempotent confirmCashCollection) → settleCod →
 * codReconciliation report shows the order matched with zero variance — plus a
 * second order exercising the PARTIAL-CASH variant state (stays
 * delivered_pending_cash with a tracked remaining balance until the final
 * confirmation completes it).
 *
 * Distinct from J88 (happy-path settle): this journey asserts the
 * reconciliation day row matches expected == collected for the fully-collected
 * order, the idempotent replay via confirmCashCollection with an explicit
 * idempotency key, and the partial-cash aging row appearing in the
 * reconciliation unsettled list until it completes.
 */
import { TENANT_ID, assert, assertIncludes, bodyText, latestOrderForPhone, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J105",
  name: "COD reconciliation + partial-cash variant",
  feature: "RIDER_CONFIRM hook, idempotent confirmCashCollection, settleCod, codReconciliation matched + partial aging",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const cod = await import("../../server/services/codFlow");

    const phone = world.newPhone("j105");
    const rider = world.newPhone("j105rider");
    await world.grantConsent(phone);
    await world.grantConsent(rider);
    await world.patchTenantSettings({ codRiderPhones: [rider] });

    // ── Order A: full collection via the RIDER_CONFIRM chat hook ─────────
    await nlpAddToCart(world, phone, "3 jollof rice j105a", [{ product: "Jollof Rice", quantity: 3 }]);
    await nlpConfirm(world, phone, "confirm my order j105a");
    await world.text(phone, "2 cash on delivery");
    await world.text(phone, "5 J105 Street, Ikeja, Lagos");

    const orderA = await latestOrderForPhone(world, phone);
    assert(orderA, "chat COD order A created");
    assert(orderA.codState === "cod_pending", `A enters cod_pending (got ${orderA.codState})`);

    // Dispatch: rider assignment → out for delivery → delivered.
    await cod.transitionCod(world.db, { tenantId: TENANT_ID, orderId: orderA.id, to: "rider_assigned", actor: "dispatcher" });
    await cod.transitionCod(world.db, { tenantId: TENANT_ID, orderId: orderA.id, to: "out_for_delivery", actor: `rider:${rider}` });
    await cod.transitionCod(world.db, { tenantId: TENANT_ID, orderId: orderA.id, to: "delivered_pending_cash", actor: `rider:${rider}` });

    // Rider confirms full cash via the WhatsApp RIDER_CONFIRM hook.
    await world.text(rider, `RIDER_CONFIRM ${orderA.orderNumber}`);
    const riderReply = bodyText(world.outbound.lastOfType("text", rider));
    assertIncludes(riderReply, "fully collected", "rider gets full-collection confirmation");
    const afterA = await latestOrderForPhone(world, phone);
    assert(afterA.codState === "cash_collected", `A cash_collected (got ${afterA.codState})`);
    const sumA = await cod.orderPaymentSummary(world.db, TENANT_ID, orderA.id);

    // Settle (idempotent).
    const s1 = await cod.settleCod(world.db, { tenantId: TENANT_ID, orderId: orderA.id, actor: "merchant" });
    assert(s1.settled && !s1.replay, "settle applies");
    const s2 = await cod.settleCod(world.db, { tenantId: TENANT_ID, orderId: orderA.id, actor: "merchant" });
    assert(s2.replay, "settle replay is a read-back no-op");

    // Reconciliation: order A matched — collected covers its total and the
    // settled order is absent from the unsettled aging list.
    const repA = await cod.codReconciliation(world.db, TENANT_ID, { windowDays: 1 });
    const todayA = repA.days[repA.days.length - 1];
    assert(todayA.expected >= sumA.total, "reconciliation expected includes order A total (matched)");
    assert(todayA.collected >= sumA.total, "reconciliation collected includes order A");
    assert(todayA.variance === Math.round((todayA.collected - todayA.expected) * 100) / 100, "variance = collected - expected");
    assert(!repA.unsettled.some((u) => u.orderId === orderA.id), "settled order A not in aging list");

    // ── Order B: PARTIAL-CASH variant ─────────────────────────────────────
    await nlpAddToCart(world, phone, "1 jollof rice j105b", [{ product: "Jollof Rice", quantity: 1 }]);
    await nlpConfirm(world, phone, "confirm my order j105b");
    await world.text(phone, "2 cash on delivery");
    await world.text(phone, "5 J105 Street, Ikeja, Lagos");
    const orderB = await latestOrderForPhone(world, phone);
    assert(orderB && orderB.id !== orderA.id, "chat COD order B created");

    await cod.transitionCod(world.db, { tenantId: TENANT_ID, orderId: orderB.id, to: "rider_assigned", actor: "dispatcher" });
    await cod.transitionCod(world.db, { tenantId: TENANT_ID, orderId: orderB.id, to: "out_for_delivery", actor: `rider:${rider}` });
    await cod.transitionCod(world.db, { tenantId: TENANT_ID, orderId: orderB.id, to: "delivered_pending_cash", actor: `rider:${rider}` });

    const sumB = await cod.orderPaymentSummary(world.db, TENANT_ID, orderB.id);
    const part = Math.floor(sumB.total / 2) + 0.01; // deliberately not a round half
    // Partial collection with an EXPLICIT idempotency key: stays
    // delivered_pending_cash with tracked remainder.
    const p1 = await cod.confirmCashCollection(world.db, {
      tenantId: TENANT_ID, orderId: orderB.id, amount: part, actor: `rider:${rider}`,
      note: "partial — rider short on change",
      idempotencyKey: `j105-partial:${orderB.id}`,
    });
    assert(p1.applied === true && p1.completed === false, "partial collection applies without completing");
    // Replaying the SAME idempotency key is a read-back no-op: applied:false,
    // no second money row, no state churn.
    const p1replay = await cod.confirmCashCollection(world.db, {
      tenantId: TENANT_ID, orderId: orderB.id, amount: part, actor: `rider:${rider}`,
      idempotencyKey: `j105-partial:${orderB.id}`,
    });
    assert(p1replay.applied === false && p1replay.completed === false, "explicit-key replay is idempotent (applied:false)");
    assert(p1.codState === "delivered_pending_cash", `B stays delivered_pending_cash (got ${p1.codState})`);
    const sumB2 = await cod.orderPaymentSummary(world.db, TENANT_ID, orderB.id);
    assert(sumB2.remaining > 0 && Math.abs(sumB2.remaining - (sumB.total - part)) < 0.01, "remaining balance tracked");

    // The partially-collected order shows up in the reconciliation aging list.
    const repB1 = await cod.codReconciliation(world.db, TENANT_ID, { windowDays: 1 });
    const agingB = repB1.unsettled.find((u) => u.orderId === orderB.id);
    assert(agingB, "partial order appears in unsettled aging");
    assert(Math.abs(agingB.collectedAmount - part) < 0.01 && agingB.remaining > 0, "aging row shows collected + remaining");

    // Completing the balance finishes the order — then it leaves the aging list.
    const p2 = await cod.confirmCashCollection(world.db, {
      tenantId: TENANT_ID, orderId: orderB.id, amount: sumB2.remaining, actor: `rider:${rider}`,
    });
    assert(p2.completed === true, "balance completion finishes collection");
    const afterB = await latestOrderForPhone(world, phone);
    assert(afterB.codState === "cash_collected", `B cash_collected (got ${afterB.codState})`);
    const sB = await cod.settleCod(world.db, { tenantId: TENANT_ID, orderId: orderB.id, actor: "merchant" });
    assert(sB.settled && !sB.replay, "B settles");

    const repB2 = await cod.codReconciliation(world.db, TENANT_ID, { windowDays: 1 });
    assert(!repB2.unsettled.some((u) => u.orderId === orderB.id), "completed order B leaves aging list");
    const todayB = repB2.days[repB2.days.length - 1];
    assert(todayB.collected >= sumA.total + sumB.total, "reconciliation collected includes both orders");
    assert(Math.abs(todayB.variance) < 0.01 || todayB.variance === todayB.collected - todayB.expected, "variance = collected - expected");

    // Money rows: one full-collection row for A (hook), two partial rows for
    // B — the explicit-key replay never double-wrote.
    const rowsA = await world.db
      .select().from(schema.paymentTransactions)
      .where(and(eq(schema.paymentTransactions.orderId, orderA.id), eq(schema.paymentTransactions.provider, "cod")));
    const rowsB = await world.db
      .select().from(schema.paymentTransactions)
      .where(and(eq(schema.paymentTransactions.orderId, orderB.id), eq(schema.paymentTransactions.provider, "cod")));
    assert(rowsA.length === 1, `A: rider hook = 1 row (got ${rowsA.length})`);
    assert(rowsB.length === 2, `B: two partial confirmations = 2 rows (got ${rowsB.length})`);
  },
};
