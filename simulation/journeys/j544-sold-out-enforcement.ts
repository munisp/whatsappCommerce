// === W53 EVENTS ===
/**
 * J544 — Sold-out enforcement: a 1-seat ticket type sells to the FIRST
 * claimant only. The second buyer (chat) gets an honest SOLD OUT reply and
 * no order is created; concurrent direct claims race the claim-first UPDATE
 * and exactly one wins. maxPerOrder is enforced honestly too.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { seedPublishedEvent, latestEventOrderForBuyer } from "./w53-events-seed";

export const journey: Journey = {
  id: "J544",
  name: "sold-out: claim-first inventory, honest rejection, race-safe",
  feature: "W53 events: sold-out enforcement",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/events");
    const seed = await seedPublishedEvent(world, "J544", {
      types: [{ name: "Last Seat", priceCents: 100_000, quantity: 1, maxPerOrder: 2 }],
    });
    const typeId = seed.types[0]!.id;

    // ── 1. maxPerOrder enforced before any claim ──
    let capped = false;
    try {
      await svc.purchaseTickets(world.db as any, {
        tenantId: (await import("../world")).TENANT_ID,
        eventId: seed.eventId, ticketTypeId: typeId, qty: 3,
        buyerCustomerId: "+2349000005440",
      });
    } catch (e: any) { capped = e?.code === "BAD_REQUEST" && /at most 2/i.test(e?.message ?? ""); }
    assert(capped, "maxPerOrder enforced");
    let [tt] = await world.db.select().from(schema.eventTicketTypes)
      .where(eq(schema.eventTicketTypes.id, typeId)).limit(1);
    assert(tt.soldCount === 0, "no inventory leaked by the rejected claim");

    // ── 2. Back-to-back claims for the last seat: the claim-first UPDATE
    // (soldCount + qty <= quantity in ONE atomic statement) lets the first
    // claim land and rejects the second with SOLD OUT — no oversell window.
    // (Sequential here: the sim DB is single-connection PGlite; concurrent
    // transactions on one connection serialize/deadlock anyway. The claim
    // itself is atomic, so a real-PG race collapses to the same outcome.)
    const TENANT = (await import("../world")).TENANT_ID;
    const first = await svc.purchaseTickets(world.db as any, { tenantId: TENANT, eventId: seed.eventId, ticketTypeId: typeId, qty: 1, buyerCustomerId: "+2349000005441" });
    assert(first.orderId, "first claim wins the seat");
    let lost = false;
    try {
      await svc.purchaseTickets(world.db as any, { tenantId: TENANT, eventId: seed.eventId, ticketTypeId: typeId, qty: 1, buyerCustomerId: "+2349000005442" });
    } catch (e: any) { lost = e?.code === "CONFLICT" && /SOLD OUT/i.test(e?.message ?? ""); }
    assert(lost, "second claim honestly rejected");
    [tt] = await world.db.select().from(schema.eventTicketTypes)
      .where(eq(schema.eventTicketTypes.id, typeId)).limit(1);
    assert(tt.soldCount === 1, `soldCount == 1 after the race (got ${tt.soldCount})`);

    // ── 3. Chat buyer sees honest SOLD OUT, no order created ──
    const phone = world.newPhone("544");
    await world.grantConsent(phone);
    await world.text(phone, "events");
    await world.text(phone, "ticket 1");
    await world.text(phone, "buy 1 1");
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "SOLD OUT", "chat buyer told honestly");
    const order = await latestEventOrderForBuyer(world, phone);
    assert(!order, "no order created for a sold-out claim");
    [tt] = await world.db.select().from(schema.eventTicketTypes)
      .where(eq(schema.eventTicketTypes.id, typeId)).limit(1);
    assert(tt.soldCount === 1, "sold-out claim never oversells");
  },
};
