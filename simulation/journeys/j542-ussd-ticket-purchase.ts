// === W53 EVENTS ===
/**
 * J542 — USSD ticket purchase: "events" → numbered event list (CON) →
 * event number → ticket types (CON) → type number → quantity prompt →
 * order + payment link (END). After the real paystack webhook the ticket
 * code is delivered BY TEXT to the USSD phone.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess } from "./helpers";
import { seedPublishedEvent, latestEventOrderForBuyer, paymentRefForOrder } from "./w53-events-seed";

export const journey: Journey = {
  id: "J542",
  name: "USSD events → numbered flow → link → webhook → code by text",
  feature: "W53 events: USSD/SMS ticket purchase",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const seed = await seedPublishedEvent(world, "J542");
    const phone = world.newPhone("542");
    const sid = `w53-j542-${Date.now()}`;

    // ── 1. dial → events keyword → numbered list (CON) ────────────────────
    await world.ussd(sid, phone, "");
    const list = await world.ussd(sid, phone, "events");
    assert(list.startsWith("CON"), `events list continues the session (got ${list.slice(0, 80)})`);
    assert(list.includes(seed.title), `events list carries the title (got ${list.slice(0, 200)})`);
    assert(list.includes("1."), "numbered list");

    // ── 2. pick event → ticket types (CON) ────────────────────────────────
    const types = await world.ussd(sid, phone, "1");
    assert(types.startsWith("CON"), `ticket types continue (got ${types.slice(0, 80)})`);
    assert(types.includes("General") && types.includes("2,500.00"), `ticket types listed (got ${types.slice(0, 200)})`);

    // ── 3. pick type → quantity prompt (CON) ──────────────────────────────
    const qtyPrompt = await world.ussd(sid, phone, "1");
    assert(qtyPrompt.startsWith("CON"), `qty prompt continues (got ${qtyPrompt.slice(0, 80)})`);
    assert(/how many/i.test(qtyPrompt), `qty prompt (got ${qtyPrompt.slice(0, 120)})`);

    // ── 4. qty → order + payment link (END) ───────────────────────────────
    const bought = await world.ussd(sid, phone, "2");
    assert(bought.startsWith("END"), `purchase ends the session (got ${bought.slice(0, 80)})`);
    assert(bought.includes("EVT-") && bought.includes("5,000.00"), `order summary (got ${bought.slice(0, 240)})`);
    assert(bought.includes("http"), `payment link in the END reply (got ${bought.slice(0, 240)})`);

    const order = await latestEventOrderForBuyer(world, phone);
    assert(order, "USSD event-ticket order created");
    const ref = await paymentRefForOrder(world, order.id);

    // ── 5. webhook → code delivered by text to the USSD phone ─────────────
    const res = await paystackChargeSuccess(world, { reference: ref, amountMajor: 5000 });
    assert(res.status === 200, "webhook accepted");
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      return rows.length === 2;
    }, 12000, "tickets issued");
    const tickets = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id));
    await world.waitFor(() =>
      world.outbound.ofType("text", phone).some((c) =>
        JSON.stringify(c.body ?? {}).includes(tickets[0]!.code)),
      12000, "code delivered by text");
  },
};
