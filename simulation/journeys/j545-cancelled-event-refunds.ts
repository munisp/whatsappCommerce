// === W53 EVENTS ===
/**
 * J545 — Cancelled event: merchant cancel (money-guarded router path) flags
 * every live ticket 'cancelled', records a refundsPending count on the
 * event metadata for the refund sweep, blocks further sales honestly, and
 * the door rejects cancelled tickets with the real reason. Re-cancel is an
 * idempotent no-op.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, paystackChargeSuccess } from "./helpers";
import { seedPublishedEvent, latestEventOrderForBuyer, paymentRefForOrder } from "./w53-events-seed";

export const journey: Journey = {
  id: "J545",
  name: "cancelled event → tickets cancelled + refundsPending + door rejects",
  feature: "W53 events: cancellation refunds flag",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const seed = await seedPublishedEvent(world, "J545");

    // Buyer pays through the real rail → ticket issued.
    const phone = world.newPhone("545");
    await world.grantConsent(phone);
    await world.text(phone, "events");
    await world.text(phone, "ticket 1");
    await world.text(phone, "buy 1 2");
    const order = await latestEventOrderForBuyer(world, phone);
    assert(order, "order created");
    const ref = await paymentRefForOrder(world, order.id);
    await paystackChargeSuccess(world, { reference: ref, amountMajor: 5000 });
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      return rows.length === 2;
    }, 12000, "tickets issued");

    // Merchant cancels via the router (owner membership passes the money bar).
    const userId = 5451;
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TENANT_ID, userId: String(userId), role: "owner",
    }).onConflictDoNothing();
    try {
      const caller = await tenantCaller(TENANT_ID, { userId });
      const res = await caller.events.cancelEvent({ tenantId: TENANT_ID, eventId: seed.eventId });
      assert(res.event.status === "cancelled", "event cancelled");
      assert(res.cancelledTickets === 2, `both tickets flagged (got ${res.cancelledTickets})`);
      assert(res.refundsPending === 1, `one paid order flagged for refund (got ${res.refundsPending})`);

      const [ev] = await world.db.select().from(schema.events)
        .where(eq(schema.events.id, seed.eventId)).limit(1);
      assert((ev.metadata as any)?.refundsPending === 1, "refundsPending persisted on the event");
      const tickets = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      assert(tickets.every((t) => t.status === "cancelled"), "tickets flagged cancelled");

      // Idempotent re-cancel.
      const again = await caller.events.cancelEvent({ tenantId: TENANT_ID, eventId: seed.eventId });
      assert(again.alreadyCancelled === true && again.cancelledTickets === 0, "re-cancel is a no-op");

      // Public storefront stops listing it; new sales refused honestly.
      const { publicCaller } = await import("./helpers");
      const pub = await publicCaller();
      const listed = await pub.events.listPublished({ tenantId: TENANT_ID });
      assert(!listed.some((e: any) => e.eventId === seed.eventId), "cancelled event unlisted");
      const svc = await import("../../server/services/events");
      let blocked = false;
      try {
        await svc.purchaseTickets(world.db as any, {
          tenantId: TENANT_ID, eventId: seed.eventId,
          ticketTypeId: seed.types[0]!.id, qty: 1, buyerCustomerId: "+2349000005459",
        });
      } catch (e: any) { blocked = e?.code === "CONFLICT" && /aren't on sale/i.test(e?.message ?? ""); }
      assert(blocked, "sales refused on a cancelled event");
    } finally {
      await world.db.delete(schema.tenantMemberships);
    }

    // Door: cancelled ticket is rejected with the real reason.
    const staff = world.newPhone("d545");
    await world.grantConsent(staff);
    await world.db.insert(schema.users).values({
      openId: "sim-door-j545", name: "Door Staff", phone: staff,
      tenantId: TENANT_ID, lastSignedIn: new Date(),
    }).onConflictDoNothing();
    const [ticket] = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id)).limit(1);
    await world.text(staff, `checkin ${ticket.code}`);
    const reply = bodyText(world.outbound.lastOfType("text", staff));
    assertIncludes(reply, "cancelled event", "door rejects with the real reason");
  },
};
