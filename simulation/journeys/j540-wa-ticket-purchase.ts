// === W53 EVENTS ===
/**
 * J540 — WhatsApp buyer buys tickets end-to-end:
 *   "events" → published list (image card header when the event has one)
 *   → "ticket 1" → ticket types → "buy 1 2" → order + paystack link via
 *   the EXISTING payments rail → REAL HMAC-signed charge.success webhook →
 *   paymentConfirm (untouched) → post-commit receipt seam issues 2 unique
 *   ticket codes delivered in chat. Webhook replay never double-issues.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess } from "./helpers";
import { seedPublishedEvent, latestEventOrderForBuyer, paymentRefForOrder } from "./w53-events-seed";

export const journey: Journey = {
  id: "J540",
  name: "WA events → ticket types → buy → paystack webhook → codes delivered",
  feature: "W53 events: WA ticket purchase end-to-end",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const seed = await seedPublishedEvent(world, "J540", {
      imageUrl: "https://cdn.sim/w53/j540-header.png",
    });
    const phone = world.newPhone("540");
    await world.grantConsent(phone);

    // ── 1. "events" → numbered list + image header card ──────────────────
    await world.text(phone, "events");
    const listReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(listReply, seed.title, "events list carries the event title");
    assertIncludes(listReply, "TICKET 1", "events list carries the pick hint");
    const img = world.outbound.lastOfType("image", phone);
    assert(img, "image header card sent for the imaged event");
    assert(JSON.stringify(img?.body ?? {}).includes("j540-header.png"), "card uses the event image");
    assert(JSON.stringify(img?.body ?? {}).includes(seed.title), "card caption carries the listing");

    // ── 2. "ticket 1" → ticket types ──────────────────────────────────────
    await world.text(phone, "ticket 1");
    const typesReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(typesReply, "General", "ticket types list");
    assertIncludes(typesReply, "2,500.00", "price in major units");
    assertIncludes(typesReply, "BUY 1", "buy hint");

    // ── 3. "buy 1 2" → order + payment link (existing rail) ───────────────
    await world.text(phone, "buy 1 2");
    const buyReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(buyReply, "EVT-", "order number in reply");
    assertIncludes(buyReply, "5,000.00", "integer-cents total (2 × 2500)");
    assert(buyReply.includes("http"), `payment link in reply (got ${buyReply.slice(0, 200)})`);

    const order = await latestEventOrderForBuyer(world, phone);
    assert(order, "event-ticket order row created");
    assert((order.metadata as any)?.eventTicket?.qty === 2, "order carries eventTicket metadata");
    const ref = await paymentRefForOrder(world, order.id);

    // Inventory claimed at purchase (claim-first).
    const [tt] = await world.db.select().from(schema.eventTicketTypes)
      .where(eq(schema.eventTicketTypes.id, seed.types[0]!.id)).limit(1);
    assert(tt.soldCount === 2, `soldCount claimed at purchase (got ${tt.soldCount})`);

    // ── 4. Paystack webhook → codes issued + delivered ────────────────────
    const res = await paystackChargeSuccess(world, { reference: ref, amountMajor: 5000 });
    assert(res.status === 200, `webhook accepted (got ${res.status})`);
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      return rows.length === 2;
    }, 12000, "tickets issued on payment confirm");
    const tickets = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id));
    assert(tickets.length === 2, "two tickets issued");
    assert(new Set(tickets.map((t) => t.code)).size === 2, "codes are unique");
    assert(tickets.every((t) => t.status === "issued" && t.buyerCustomerId === phone), "tickets issued to the buyer");

    await world.waitFor(() =>
      world.outbound.ofType("text", phone).some((c) =>
        JSON.stringify(c.body ?? {}).includes("Your ticket")), 12000, "codes delivered in chat");
    const delivery = world.outbound.ofType("text", phone)
      .map((c) => bodyText(c))
      .find((t) => t.includes("Your ticket"))!;
    for (const t of tickets) assertIncludes(delivery, t.code, "delivered code");

    // ── 5. Webhook replay → no double-issue ───────────────────────────────
    await paystackChargeSuccess(world, { reference: ref, amountMajor: 5000 });
    await world.settle(600);
    const after = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id));
    assert(after.length === 2, `replay never double-issues (got ${after.length})`);

    // ── 6. "my tickets" self-service ──────────────────────────────────────
    await world.text(phone, "my tickets");
    const mine = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(mine, tickets[0]!.code, "my tickets lists the code");
  },
};
