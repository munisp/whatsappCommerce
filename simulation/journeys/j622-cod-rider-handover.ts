/**
 * J622 — cash on delivery at the door (built 2026-11-10 after the rider test showed three gaps):
 *   1. a COD delivery order now gets a delivery PIN, in its order message (paid orders get theirs on the receipt);
 *   2. the rider records the cash collected — the order walks the COD machine and the cash is confirmed once,
 *      a shortfall raising the shop's discrepancy alert — before it's marked delivered;
 *   3. the COD order's management card no longer offers "Pay Now" (it answered "I couldn't find a payment link").
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, latestOrderForPhone, type World } from "../world";
import { nlpAddToCart, nlpConfirm } from "./helpers";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J622",
  name: "COD delivery: PIN in the order message, rider records the cash, no Pay Now",
  feature: "nlp COD ensureDeliveryShipment + handover cash (codFlow) + order card",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { appRouter } = await import("../../server/routers");
    const { riderToken } = await import("../../server/services/riderToken");
    const anon = appRouter.createCaller({ user: null } as any);
    const phone = world.newPhone("j622");
    await world.grantConsent(phone);

    await nlpAddToCart(world, phone, "2 jollof rice j622", [{ product: "Jollof Rice", quantity: 2 }]);
    await nlpConfirm(world, phone, "confirm my order j622");
    await world.text(phone, "2 cash on delivery");
    await world.text(phone, "9 J622 Close, Ikeja, Lagos");
    const order = await latestOrderForPhone(world, phone);
    assert(order && order.codState === "cod_pending", `a COD order is created (got ${order?.codState})`);

    const texts = world.outbound.ofType("text", phone).map((m: any) => bodyText(m)).join("\n");
    const pinMatch = /Your delivery PIN: \*?(\d{4,8})\*?/.exec(texts);
    assert(!!pinMatch, `the COD order message carries a delivery PIN (got: ${texts.slice(-500)})`);
    const pin = pinMatch![1];
    const cards = world.outbound.ofType("interactive", phone).map((m: any) => JSON.stringify(m.body ?? m));
    const card = cards.find((c: string) => c.includes("manage it here"));
    assert(!!card && !card.includes("Pay Now") && card.includes("Track Order"), `the COD order card has no Pay Now (got ${card?.slice(0, 300)})`);

    const token = riderToken(order.id);
    const view = await anon.rider.view({ token });
    const due = Number(order.totalAmount);
    assert(view.needsPin === true && view.cashDue === due, `the rider is asked for the PIN and ₦${due} cash (got ${JSON.stringify({ needsPin: view.needsPin, cashDue: view.cashDue })})`);

    const refused = async (p: Promise<unknown>, what: string, code: string) => {
      try { await p; assert(false, `${what} should be refused`); } catch (e: any) { assert(e?.code === code, `${what}: refused with ${code} (got ${e?.code}: ${e?.message})`); }
    };
    await refused(anon.rider.confirm({ token, pin }), "delivering a COD order without saying how much cash was collected", "BAD_REQUEST");
    await refused(anon.rider.confirm({ token, pin: "0000", cashCollected: due }), "a wrong PIN", "BAD_REQUEST");

    const short = due - 500;
    const done = await anon.rider.confirm({ token, pin, cashCollected: short });
    assert(done.delivered === true, "delivered with the PIN and the cash");
    const [after] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    assert(after.status === "delivered" && after.codState === "cash_collected", `order delivered and cash collected (got ${after.status}/${after.codState})`);
    const states = (await world.db.select().from(schema.codEvents).where(eq(schema.codEvents.orderId, order.id))).map((e: any) => e.toState);
    for (const s of ["rider_assigned", "out_for_delivery", "delivered_pending_cash", "cash_collected"]) assert(states.includes(s), `COD step ${s} recorded (got ${states.join(",")})`);
    const alerts = await world.db.select().from(schema.merchantNotifications)
      .where(and(eq(schema.merchantNotifications.tenantId, TENANT_ID), eq(schema.merchantNotifications.type, "cod_discrepancy")));
    assert(alerts.some((a: any) => JSON.stringify(a).includes(order.orderNumber)), "a ₦500 shortfall alerts the shop");
    const again = await anon.rider.view({ token });
    assert(again.delivered === true && again.cashDue === null, "opening the link again: delivered, nothing left to collect");
  },
};
