// === W44 deposits-subs-digital (Coder C) ===
/**
 * J347 — Appointment booking happy path, BOTH channels:
 *  WA: "services" lists bookable services → "book <svc> at <time>" parks a
 *      claim-first (overlap-guarded) appointment + deposit payment link →
 *      paystack webhook confirms the deposit (appt-deposit:<id>) →
 *      confirmed + customer notified. Merchant "APPT COMPLETE <id8>" →
 *      remainder charged from the wallet (W41, idempotent appt-remainder:<id>).
 *  TG: a telegram-linked buyer books the same way (shared nlp engine) and
 *      the deposit confirmation routes through channelSender (telegram).
 *  Overlap guard: a second booking over the same slot is refused.
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedServiceProduct, bindTelegram } from "./w44-seed";
import { paystackChargeSuccess } from "./helpers";
import { addStaffUser } from "./w43-dispatch-seed";

export const journey: Journey = {
  id: "J347",
  name: "appointment booking + deposit + wallet remainder (WA+TG)",
  feature: "service_appointments + overlap guard + deposit/remainder + parity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await seedServiceProduct(world, "j347");

    // ── WA buyer: discover + book ──
    const phone = world.newPhone("j347");
    await world.grantConsent(phone);

    await world.text(phone, "services");
    let reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, svc.name, "services list includes the service");
    assertIncludes(reply, "50% deposit", "deposit policy surfaced");

    await world.text(phone, `book ${svc.name} at in 3 hours`);
    reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "Deposit:", "booking reply quotes the deposit");
    assertIncludes(reply, "Pay deposit:", "deposit payment link sent");
    assertIncludes(reply, "remainder", "remainder disclosed");

    const [appt] = await world.db.select().from(schema.serviceAppointments)
      .where(and(
        eq(schema.serviceAppointments.tenantId, TENANT_ID),
        eq(schema.serviceAppointments.customerId, phone),
      ))
      .orderBy(desc(schema.serviceAppointments.createdAt))
      .limit(1);
    assert(appt, "service_appointments row created");
    assert(appt.status === "booked", `booked (got ${appt.status})`);
    assert(appt.depositStatus === "pending", "deposit pending before payment");
    assert(appt.depositCents === 10_000, `50% deposit = 10000 (got ${appt.depositCents})`);
    assert(appt.remainderCents === 10_000, "remainder 10000");
    assert(appt.depositRef === `appt-deposit:${appt.id}`, "deposit reference stamped");
    assert(appt.endsAt.getTime() - appt.startsAt.getTime() === 3600_000, "60 min duration");

    // ── Overlap guard: same slot refused (claim-first) ──
    const phone2 = world.newPhone("j347b");
    await world.grantConsent(phone2);
    await world.text(phone2, `book ${svc.name} at in 3 hours`);
    const overlapReply = bodyText(world.outbound.lastOfType("text", phone2));
    assertIncludes(overlapReply, "already booked", "overlapping slot refused");

    // ── Deposit paid via the REAL paystack webhook ──
    const dep = await paystackChargeSuccess(world, { reference: appt.depositRef!, amountMajor: 100 });
    assert(dep.status === 200, `deposit webhook accepted (got ${dep.status})`);
    await world.waitFor(async () => {
      const [a] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, appt.id));
      return a?.status === "confirmed" && a?.depositStatus === "paid";
    }, 10000, "deposit confirmed the booking");
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phone);
      return !!t && bodyText(t).includes("is confirmed");
    }, 10000, "customer got the confirmation");
    // Webhook replay is idempotent (no duplicate flip/notification).
    const depReplay = await paystackChargeSuccess(world, { reference: appt.depositRef!, amountMajor: 100 });
    assert(depReplay.status === 200, "replay accepted");
    const [afterReplay] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, appt.id));
    assert(afterReplay.status === "confirmed" && afterReplay.depositStatus === "paid", "replay no-op");

    // ── Completion: remainder charged from the customer wallet (W41) ──
    const merchant = world.newPhone("j347m");
    await world.grantConsent(merchant);
    await addStaffUser(world, "j347", merchant);
    const { creditWallet } = await import("../../server/services/customerWallet");
    const credited = await creditWallet(TENANT_ID, phone, 50_000, "topup", `j347-topup-${appt.id.slice(0, 8)}`, world.db);
    assert(credited.ok, `wallet topped up (${credited.error ?? "ok"})`);

    await world.text(merchant, `APPT COMPLETE ${appt.id.slice(0, 8)}`);
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "completed", "merchant completion reply");
    assertIncludes(mReply, "wallet", "remainder charged from wallet");

    const [done] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, appt.id));
    assert(done.status === "completed", `completed (got ${done.status})`);
    assert(done.remainderStatus === "paid", "remainder paid via wallet");

    // ── TG leg: telegram-linked buyer books; confirmation routes to telegram ──
    const tgPhone = world.newPhone("j347tg");
    await world.grantConsent(tgPhone);
    const chatId = "j347chat";
    await bindTelegram(world, tgPhone, chatId);
    const parity = await import("../../server/services/channelParity");
    const tgSeen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p) => {
      tgSeen.push({ channel, to, ...(p as any) });
      return { sent: true, simulated: false };
    });
    try {
      const { bookAppointment } = await import("../../server/services/appointments");
      const startsAt = new Date(Date.now() + 26 * 3600_000);
      const r = await bookAppointment(world.db, {
        tenantId: TENANT_ID,
        customerRef: `telegram:${chatId}`,
        serviceProductId: svc.productId,
        startsAt,
        channel: "telegram",
      });
      assert(r.paymentUrl, "TG booking got a deposit link");
      const depTg = await paystackChargeSuccess(world, { reference: `appt-deposit:${r.appt.id}`, amountMajor: 100 });
      assert(depTg.status === 200, "TG deposit webhook accepted");
      await world.waitFor(async () => {
        const [a] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, r.appt.id));
        return a?.status === "confirmed";
      }, 10000, "TG appointment confirmed");
      await world.waitFor(() => tgSeen.some((c) => c.channel === "telegram" && c.to === chatId && JSON.stringify(c).includes("is confirmed")),
        10000, "telegram confirmation routed via channelSender");
    } finally {
      parity.__setChannelSenderForTests(null);
    }
  },
};
