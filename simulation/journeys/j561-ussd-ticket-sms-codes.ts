// === W55 parity (PARITY-2) ===
/**
 * J561 — USSD ticket purchase code delivery: the USSD events flow marks the
 * order metadata originChannel="ussd"; on payment confirmation the codes
 * are delivered via WA text AND an SMS copy (smsSender, idempotent
 * event-ticket-sms:<orderId>, fail-open) so a feature-phone buyer without
 * WA reachability still receives them; the buyer can also pull the codes
 * in-session via USSD "my tickets" (read-only listBuyerTickets, END reply
 * within length limits).
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess } from "./helpers";
import { seedPublishedEvent, latestEventOrderForBuyer, paymentRefForOrder } from "./w53-events-seed";

export const journey: Journey = {
  id: "J561",
  name: "USSD ticket purchase → SMS code copy + USSD my-tickets pull",
  feature: "W55 parity: USSD event-ticket code delivery (PARITY-2)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const seed = await seedPublishedEvent(world, "J561");
    const phone = world.newPhone("561");
    const sid = `w55-j561-${Date.now()}`;

    // ── 1. USSD purchase flow (same numbered path as J542) ──────────────
    await world.ussd(sid, phone, "");
    const list = await world.ussd(sid, phone, "events");
    assert(list.startsWith("CON") && list.includes(seed.title), `events list (got ${list.slice(0, 120)})`);
    await world.ussd(sid, phone, "1"); // pick event
    await world.ussd(sid, phone, "1"); // pick General type
    const bought = await world.ussd(sid, phone, "1"); // qty 1
    assert(bought.startsWith("END") && bought.includes("EVT-"), `order summary (got ${bought.slice(0, 200)})`);

    const order = await latestEventOrderForBuyer(world, phone);
    assert(order, "USSD event-ticket order created");
    // === W55 parity (PARITY-2) === origin channel recorded for delivery.
    assert((order.metadata as any)?.eventTicket?.originChannel === "ussd",
      "order metadata marks originChannel=ussd");
    const ref = await paymentRefForOrder(world, order.id);

    // ── 2. payment webhook → tickets issued + SMS code copy ─────────────
    const res = await paystackChargeSuccess(world, { reference: ref, amountMajor: 2500 });
    assert(res.status === 200, "webhook accepted");
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      return rows.length === 1;
    }, 12000, "tickets issued");
    const [ticket] = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id));
    // WA text copy still lands (existing channelParity route).
    await world.waitFor(() =>
      world.outbound.ofType("text", phone).some((c) =>
        JSON.stringify(c.body ?? {}).includes(ticket!.code)),
      12000, "code delivered by WA text");
    // === W55 parity (PARITY-2) === SMS copy with the SAME code.
    await world.waitFor(async () => {
      const rows = await world.db.select({ body: schema.channelMessages.body, metadata: schema.channelMessages.metadata })
        .from(schema.channelMessages)
        .where(and(
          eq(schema.channelMessages.tenantId, TENANT_ID),
          eq(schema.channelMessages.channel, "sms"),
          eq(schema.channelMessages.direction, "outbound"),
          eq(schema.channelMessages.toAddress, phone),
        ))
        .orderBy(desc(schema.channelMessages.createdAt)).limit(5);
      return rows.some((r) => String(r.body ?? "").includes(ticket!.code));
    }, 12000, "ticket code delivered by SMS copy");
    const smsRows = await world.db.select({ body: schema.channelMessages.body, metadata: schema.channelMessages.metadata })
      .from(schema.channelMessages)
      .where(and(
        eq(schema.channelMessages.channel, "sms"),
        eq(schema.channelMessages.toAddress, phone),
      ))
      .orderBy(desc(schema.channelMessages.createdAt)).limit(1);
    assert((smsRows[0]?.metadata as any)?.failoverKey === `event-ticket-sms:${order.id}`,
      "SMS copy idempotency-keyed per order");

    // ── 3. USSD "my tickets" → codes in the USSD response text ──────────
    const mine = await world.ussd(`${sid}-tix`, phone, "my tickets");
    assert(mine.startsWith("END"), `my tickets ends the session (got ${mine.slice(0, 80)})`);
    assert(mine.includes(ticket!.code), `USSD response carries the ticket code (got ${mine.slice(0, 200)})`);
    assert(mine.length <= 160, `within USSD length budget (got ${mine.length})`);
  },
};
