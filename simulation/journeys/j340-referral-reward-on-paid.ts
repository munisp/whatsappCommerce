// === W44 giftcards-referrals (Coder A) ===
/**
 * J340 — Referral lifecycle: referrer mints a code in chat ("my referral
 * code"), the referee links it in chat ("use referral CODE") — attribution
 * requires the referee's FIRST order and rejects self-referral; when the
 * referee's order goes PAID (real paystack webhook through the pinned
 * confirm path), the W44 hook flips the event to 'rewarded' claim-first and
 * credits the referrer's wallet (W41 creditWallet, tenants.referralRewardCents
 * sized). Duplicate attribution is a no-op; replayed webhook never
 * double-credits. Program OFF (reward 0) links but moves no money.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp, paystackChargeSuccess, adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J340",
  name: "referral: chat attribution → reward on referee order PAID → wallet credit",
  feature: "W44 referral_codes + referral_events + creditWallet reward",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const refs = await import("../../server/services/referrals");
    const wallet = await import("../../server/services/customerWallet");

    // Merchant turns the program on: ₦500 reward (integer kobo).
    const caller = await adminCaller();
    await caller.referrals.setRewardCents({ tenantId: TENANT_ID, rewardCents: 50000 });

    // ── Referrer mints their code in chat ──
    const referrer = world.newPhone("j340r");
    await world.grantConsent(referrer);
    await world.text(referrer, "my referral code");
    const mintReply = bodyText(world.outbound.lastOfType("text", referrer));
    const codeMatch = /REF-[A-Z0-9]{6}/.exec(mintReply);
    assert(codeMatch, `code minted in chat (got ${mintReply.slice(0, 120)})`);
    const code = codeMatch[0];

    // ── Self-referral rejected ──
    await world.text(referrer, `use referral ${code}`);
    const selfReply = bodyText(world.outbound.lastOfType("text", referrer));
    assertIncludes(selfReply, "can't use your own referral code", "self-referral rejected");

    // ── Referee attributes in chat ──
    const referee = world.newPhone("j340e");
    await world.grantConsent(referee);
    await world.text(referee, `use referral ${code}`);
    const attrReply = bodyText(world.outbound.lastOfType("text", referee));
    assertIncludes(attrReply, "linked", "attribution confirmed in chat");

    let events = await world.db.select().from(schema.referralEvents)
      .where(eq(schema.referralEvents.tenantId, TENANT_ID));
    assert(events.length === 1 && events[0].status === "attributed", "one attributed event");
    assert(events[0].refereeCustomerId === referee, "referee recorded");

    // Duplicate attribution (same referee) is a no-op.
    const dup = await refs.attributeReferral(TENANT_ID, { code, refereeCustomerId: referee });
    assert(dup.ok && dup.duplicate === true, "second attribution is a duplicate");
    events = await world.db.select().from(schema.referralEvents).where(eq(schema.referralEvents.tenantId, TENANT_ID));
    assert(events.length === 1, "still exactly one event");

    // ── Referee's first order goes PAID → referrer wallet credited ──
    const order = await createChatOrderViaNlp(world, referee, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    assert(order.paymentRef, "payment reference captured");
    const pay = await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: 2500 });
    assert(pay.status === 200, "webhook accepted");

    await world.waitFor(async () => {
      const [ev] = await world.db.select().from(schema.referralEvents)
        .where(and(eq(schema.referralEvents.tenantId, TENANT_ID), eq(schema.referralEvents.refereeCustomerId, referee)));
      return ev?.status === "rewarded";
    }, 10000, "event rewarded on PAID");
    const [ev] = await world.db.select().from(schema.referralEvents)
      .where(eq(schema.referralEvents.refereeCustomerId, referee));
    assert(ev.orderId === order.orderId, "order linked");
    assert(ev.rewardCents === 50000, `reward sized by tenant config (got ${ev.rewardCents})`);

    const balance = await wallet.walletBalance(TENANT_ID, referrer);
    assert(balance === 50000, `referrer wallet credited ₦500 (got ${balance})`);

    // Referrer notified on their channel.
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", referrer);
      return !!t && bodyText(t).includes("referral");
    }, 10000, "referrer reward notice");
    const notice = bodyText(world.outbound.lastOfType("text", referrer));
    assertIncludes(notice, code, "notice references the code");

    // Webhook replay: exactly-once (claim-first transition + idempotent wallet credit).
    await paystackChargeSuccess(world, { reference: order.paymentRef!, amountMajor: 2500 });
    const balance2 = await wallet.walletBalance(TENANT_ID, referrer);
    assert(balance2 === 50000, "replay never double-credits");

    // ── Second paid order: no second reward (one attribution per referee) ──
    // (The cart persists per session, so the second order carries BOTH jollofs.)
    const order2 = await createChatOrderViaNlp(world, referee, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    await paystackChargeSuccess(world, { reference: order2.paymentRef!, amountMajor: 5000 });
    const balance3 = await wallet.walletBalance(TENANT_ID, referrer);
    assert(balance3 === 50000, "no reward on the referee's SECOND order");

    // ── Program OFF (reward 0): attribution links but moves no money ──
    await caller.referrals.setRewardCents({ tenantId: TENANT_ID, rewardCents: 0 });
    const referrer2 = world.newPhone("j340s");
    const referee2 = world.newPhone("j340t");
    await world.grantConsent(referee2);
    const codeRow2 = await refs.getOrCreateReferralCode(TENANT_ID, referrer2);
    const attr2 = await refs.attributeReferral(TENANT_ID, { code: codeRow2.code, refereeCustomerId: referee2 });
    assert(attr2.ok, "attribution works with program off");
    const order3 = await createChatOrderViaNlp(world, referee2, {
      items: [{ product: "Jollof Rice", quantity: 1 }],
    });
    await paystackChargeSuccess(world, { reference: order3.paymentRef!, amountMajor: 2500 });
    const balOff = await wallet.walletBalance(TENANT_ID, referrer2);
    assert(balOff === 0, "program off → no wallet credit");
    const [evOff] = await world.db.select().from(schema.referralEvents)
      .where(eq(schema.referralEvents.refereeCustomerId, referee2));
    assert(evOff.status === "attributed" && evOff.orderId === order3.orderId, "order linked, money untouched");
  },
};
