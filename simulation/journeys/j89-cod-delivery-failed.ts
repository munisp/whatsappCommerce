/**
 * J89 — COD failure branch: chat COD order → out for delivery →
 * delivery_failed (reason recorded, merchant notified) → retry refused →
 * returned. Merchant notification lands on every failure-branch transition.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, latestOrderForPhone, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart, nlpConfirm } from "./helpers";

export const journey: Journey = {
  id: "J89",
  name: "COD delivery_failed → returned",
  feature: "failure branches + merchant alerts",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    await nlpAddToCart(world, phone, "1 grilled chicken j89", [{ product: "Grilled Chicken", quantity: 1 }]);
    await nlpConfirm(world, phone, "confirm my order j89");
    await world.text(phone, "2 — cash on delivery please");
    await world.text(phone, "5 Broad Street, Lagos");

    const orderMsg = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(orderMsg, "Cash on delivery", "COD summary shown");
    const order = await latestOrderForPhone(world, phone);
    assert(order?.codState === "cod_pending", "order in COD flow");

    const { transitionCod } = await import("../../server/services/codFlow");
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "rider_assigned", actor: "dispatcher" });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "out_for_delivery", actor: "rider" });

    // delivery_failed requires a reason.
    let noReasonThrew = false;
    try {
      await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "delivery_failed", actor: "rider" });
    } catch (e: any) {
      noReasonThrew = e?.name === "CodTransitionError";
    }
    assert(noReasonThrew, "delivery_failed without reason rejected");

    await transitionCod(world.db, {
      tenantId: TENANT_ID, orderId: order.id, to: "delivery_failed",
      actor: "rider", reason: "customer unreachable — gate locked",
    });

    const schema = await import("../../drizzle/schema");
    const notifs = await world.db
      .select().from(schema.merchantNotifications)
      .where(and(
        eq(schema.merchantNotifications.tenantId, TENANT_ID),
        eq(schema.merchantNotifications.type, "cod_delivery_failed"),
      ));
    const notif = notifs.find((n) => (n.metadata as any)?.orderId === order.id);
    assert(notif, "merchant notified of delivery failure");
    assertIncludes(notif!.body, "gate locked", "notification carries the reason");

    // Retry once, customer refuses, order is returned (terminal).
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "rider_assigned", actor: "dispatcher", note: "retry next morning" });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "out_for_delivery", actor: "rider" });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "refused", actor: "rider", note: "customer refused at the door" });
    await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "returned", actor: "rider" });

    const final = await latestOrderForPhone(world, phone);
    assert(final.codState === "returned", `order returned (got ${final.codState})`);
    assert(final.paymentStatus === "unpaid", "returned COD order stays unpaid");

    // Terminal: nothing leaves `returned`.
    let terminalThrew = false;
    try {
      await transitionCod(world.db, { tenantId: TENANT_ID, orderId: order.id, to: "rider_assigned", actor: "dispatcher" });
    } catch (e: any) {
      terminalThrew = e?.name === "CodTransitionError";
    }
    assert(terminalThrew, "returned is terminal");

    // Full audit trail present.
    const events = await world.db
      .select().from(schema.codEvents)
      .where(eq(schema.codEvents.orderId, order.id));
    const states = events.map((e) => e.toState);
    for (const s of ["cod_pending", "rider_assigned", "out_for_delivery", "delivery_failed", "refused", "returned"]) {
      assert(states.includes(s), `audit trail includes ${s}`);
    }
  },
};
