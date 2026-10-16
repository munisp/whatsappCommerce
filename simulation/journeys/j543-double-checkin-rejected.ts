// === W53 EVENTS ===
/**
 * J543 — Check-in is claim-first: the door staffer's first "checkin <CODE>"
 * flips issued → checked_in; the SAME code a second time is honestly
 * rejected ("already checked in at …"); a non-staff sender is refused; an
 * unknown code is answered honestly. Router checkIn mirrors the chat path.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, paystackChargeSuccess, expectTrpcError } from "./helpers";
import { seedPublishedEvent, latestEventOrderForBuyer, paymentRefForOrder } from "./w53-events-seed";

export const journey: Journey = {
  id: "J543",
  name: "double check-in rejected; staff-only; unknown code honest",
  feature: "W53 events: claim-first check-in",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const seed = await seedPublishedEvent(world, "J543");

    // Issue one ticket (buyer pays through the real rail).
    const phone = world.newPhone("543");
    await world.grantConsent(phone);
    await world.text(phone, "events");
    await world.text(phone, "ticket 1");
    await world.text(phone, "buy 1 1");
    const order = await latestEventOrderForBuyer(world, phone);
    assert(order, "order created");
    const ref = await paymentRefForOrder(world, order.id);
    await paystackChargeSuccess(world, { reference: ref, amountMajor: 2500 });
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      return rows.length === 1;
    }, 12000, "ticket issued");
    const [ticket] = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id)).limit(1);

    // Door staffer (users row = staff phone).
    const staff = world.newPhone("d543");
    await world.grantConsent(staff);
    await world.db.insert(schema.users).values({
      openId: "sim-door-j543", name: "Door Staff", phone: staff,
      tenantId: TENANT_ID, lastSignedIn: new Date(),
    }).onConflictDoNothing();

    // First check-in → welcome.
    await world.text(staff, `checkin ${ticket.code}`);
    let reply = bodyText(world.outbound.lastOfType("text", staff));
    assertIncludes(reply, "Checked in", "first check-in succeeds");
    assertIncludes(reply, ticket.code, "reply carries the code");
    let [row] = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.id, ticket.id)).limit(1);
    assert(row.status === "checked_in" && row.checkedInAt, "status flipped claim-first");

    // Second check-in → honest rejection.
    await world.text(staff, `checkin ${ticket.code}`);
    reply = bodyText(world.outbound.lastOfType("text", staff));
    assertIncludes(reply, "already checked in", "double check-in honestly rejected");

    // Router path mirrors it (CONFLICT).
    const userId = 5431;
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TENANT_ID, userId: String(userId), role: "operator",
    }).onConflictDoNothing();
    const caller = await tenantCaller(TENANT_ID, { userId });
    const err = await expectTrpcError(
      caller.events.checkIn({ tenantId: TENANT_ID, code: ticket.code }),
      "CONFLICT", "router double check-in",
    );
    assert(/already checked in/i.test(err.message), `router rejection honest (got ${err.message})`);

    // Non-staff sender refused.
    await world.text(phone, `checkin ${ticket.code}`);
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "only store staff", "non-staff refused");

    // Unknown code → honest.
    await world.text(staff, "checkin T-DEADBEEF");
    reply = bodyText(world.outbound.lastOfType("text", staff));
    assertIncludes(reply, "couldn't find", "unknown code honest");
  },
};
