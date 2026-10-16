// === W53 EVENTS ===
/**
 * J541 — Telegram parity purchase: the SAME deterministic engine answers
 * "events" / "ticket 1" / "buy 1" on TG; the payment link arrives as a TG
 * sendMessage, and after the real paystack webhook the ticket codes are
 * delivered to the TG chat via the channelParity route.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { paystackChargeSuccess } from "./helpers";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";
import { seedPublishedEvent, latestEventOrderForBuyer, paymentRefForOrder } from "./w53-events-seed";

export const journey: Journey = {
  id: "J541",
  name: "TG events → buy → webhook → codes delivered to the TG chat",
  feature: "W53 events: Telegram purchase parity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const { recordConsent } = await import("../../server/services/consent");
    await ensureTelegramConfig(world);
    const seed = await seedPublishedEvent(world, "J541");

    const chatId = "880541";
    const buyerRef = `telegram:${chatId}`;
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: buyerRef, channel: "telegram", granted: true });

    const tgSend = async (updateId: number, text: string, label: string) => {
      const before = tg.callsFor("sendMessage").length;
      const res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(updateId, chatId, 770541, text));
      assert(res.status === 200, `${label}: webhook acked (got ${res.status})`);
      await world.waitFor(() => tg.callsFor("sendMessage").length > before, 12000, `${label}: TG reply`);
      return String(tg.callsFor("sendMessage").at(-1)!.body?.text ?? "");
    };

    // ── 1. events list on TG ──
    const list = await tgSend(970541, "events", "events");
    assert(list.includes(seed.title), `TG events list carries the title (got ${list.slice(0, 200)})`);

    // ── 2. ticket types on TG ──
    const types = await tgSend(970542, "ticket 1", "ticket 1");
    assert(types.includes("General"), `TG ticket types (got ${types.slice(0, 200)})`);

    // ── 3. buy → order + link on TG ──
    const buy = await tgSend(970543, "buy 1", "buy 1");
    assert(buy.includes("EVT-") && buy.includes("http"), `TG buy reply carries order + link (got ${buy.slice(0, 240)})`);

    const order = await latestEventOrderForBuyer(world, buyerRef);
    assert(order, "TG event-ticket order created");
    const ref = await paymentRefForOrder(world, order.id);

    // ── 4. webhook → code delivered to the TG chat ──
    const res = await paystackChargeSuccess(world, { reference: ref, amountMajor: 2500 });
    assert(res.status === 200, "webhook accepted");
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.eventTickets)
        .where(eq(schema.eventTickets.orderId, order.id));
      return rows.length === 1;
    }, 12000, "ticket issued");
    const [ticket] = await world.db.select().from(schema.eventTickets)
      .where(eq(schema.eventTickets.orderId, order.id)).limit(1);
    assert(ticket.buyerCustomerId === buyerRef, "ticket bound to the TG buyer ref");
    await world.waitFor(() =>
      tg.callsFor("sendMessage").some((c) =>
        String(c.body?.chat_id) === chatId && String(c.body?.text ?? "").includes(ticket.code)),
      12000, "code delivered to the TG chat");
  },
};
