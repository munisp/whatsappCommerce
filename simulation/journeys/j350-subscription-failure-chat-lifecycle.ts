// === W44 deposits-subs-digital (Coder C) ===
/**
 * J350 — Subscription failure → past_due + dunning (max 3 retries), then
 * chat lifecycle BOTH channels:
 *  - A revoked-token subscription fails 3 consecutive ticks (dunning notice
 *    on every failure, retry_count 1→2→3) then persists past_due (no 4th
 *    charge attempted — status is terminal until resume).
 *  - "pause subscription" / "resume subscription" on WHATSAPP.
 *  - "cancel subscription" on TELEGRAM (shared nlp engine; identity binding
 *    resolves the chat id to the buyer's phone).
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedFakeToken, bindTelegram } from "./w44-seed";
import { adminCaller } from "./helpers";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J350",
  name: "subscription failure dunning → past_due; pause/cancel in chat",
  feature: "retry max 3 + dunning both channels + pause/resume/cancel",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const plan = await caller.subscriptionPlans.createPlan({
      tenantId: TENANT_ID,
      productId: "p-chicken",
      name: "Chicken Monthly",
      interval: "month",
      priceCents: 300_000,
    });

    // ── Failure path: revoke the token BEFORE the tick ──
    const phone = world.newPhone("j350");
    await world.grantConsent(phone);
    const tokenId = await seedFakeToken(world, phone);
    const { revokeCustomerToken } = await import("../../server/services/customerPaymentTokens");
    // Subscribe while the token is active, THEN revoke (provider decline path).
    const { subscribeCustomer } = await import("../../server/services/subscriptions");
    const sub = await subscribeCustomer(world.db, {
      tenantId: TENANT_ID, planId: plan.id, customerRef: phone,
      paymentTokenId: tokenId, nextBillingAt: new Date(Date.now() - 60_000),
    });
    const revoked = await revokeCustomerToken(world.db, { tenantId: TENANT_ID, buyerPhone: phone, tokenId });
    assert(revoked.ok, "token revoked");

    for (let attempt = 1; attempt <= 3; attempt++) {
      const tick = await world.runCron("/api/scheduled/subscription-billing");
      assert(tick.status === 200, `tick ${attempt} accepted`);
      const [s] = await world.db.select().from(schema.customerSubscriptions).where(eq(schema.customerSubscriptions.id, sub.id));
      assert(s.retryCount === attempt, `retry_count ${attempt} (got ${s.retryCount})`);
      const expectedStatus = attempt < 3 ? "active" : "past_due";
      assert(s.status === expectedStatus, `status after attempt ${attempt} = ${expectedStatus} (got ${s.status})`);
      await world.waitFor(() => {
        const t = world.outbound.lastOfType("text", phone);
        return !!t && /could not charge/i.test(bodyText(t));
      }, 10000, `dunning notice ${attempt}`);
      if (attempt < 3) {
        assertIncludes(bodyText(world.outbound.lastOfType("text", phone)), `attempt ${attempt}/3`, "dunning shows attempt count");
        // Next tick must retry: move nextBillingAt back into the past.
        await world.db.execute(
          `UPDATE customer_subscriptions SET next_billing_at = now() - interval '1 minute' WHERE id = '${sub.id}'`);
      } else {
        assertIncludes(bodyText(world.outbound.lastOfType("text", phone)), "past due", "terminal dunning");
      }
    }

    // No 4th charge: past_due subs are not scanned.
    const tick4 = await world.runCron("/api/scheduled/subscription-billing");
    assert(tick4.status === 200, "4th tick accepted");
    const [s4] = await world.db.select().from(schema.customerSubscriptions).where(eq(schema.customerSubscriptions.id, sub.id));
    assert(s4.retryCount === 3 && s4.status === "past_due", "past_due persists, no further retry");

    // ── Chat lifecycle on WHATSAPP (pause → resume) ──
    const phone2 = world.newPhone("j350b");
    await world.grantConsent(phone2);
    const token2 = await seedFakeToken(world, phone2);
    await subscribeCustomer(world.db, {
      tenantId: TENANT_ID, planId: plan.id, customerRef: phone2,
      paymentTokenId: token2, nextBillingAt: new Date(Date.now() + 86400_000),
    });

    await world.text(phone2, "pause subscription");
    let reply = bodyText(world.outbound.lastOfType("text", phone2));
    assertIncludes(reply, "paused", "pause ack");
    let subs2 = await world.db.select().from(schema.customerSubscriptions)
      .where(and(eq(schema.customerSubscriptions.tenantId, TENANT_ID), eq(schema.customerSubscriptions.customerId, phone2)))
      .orderBy(desc(schema.customerSubscriptions.createdAt)).limit(1);
    assert(subs2[0].status === "paused", `paused (got ${subs2[0].status})`);

    await world.text(phone2, "resume subscription");
    reply = bodyText(world.outbound.lastOfType("text", phone2));
    assertIncludes(reply, "active again", "resume ack");
    subs2 = await world.db.select().from(schema.customerSubscriptions)
      .where(and(eq(schema.customerSubscriptions.tenantId, TENANT_ID), eq(schema.customerSubscriptions.customerId, phone2)))
      .orderBy(desc(schema.customerSubscriptions.createdAt)).limit(1);
    assert(subs2[0].status === "active", `resumed (got ${subs2[0].status})`);

    // ── Cancel on TELEGRAM (same nlp engine via the TG webhook) ──
    await ensureTelegramConfig(world, true);
    const phone3 = world.newPhone("j350tg");
    await world.grantConsent(phone3);
    const chatId = "9035001";
    const fromId = 903501;
    await bindTelegram(world, phone3, chatId);
    const token3 = await seedFakeToken(world, phone3);
    await subscribeCustomer(world.db, {
      tenantId: TENANT_ID, planId: plan.id, customerRef: phone3,
      paymentTokenId: token3, nextBillingAt: new Date(Date.now() + 86400_000),
    });

    // TG consent dance first (j282 pattern): /start opts the chat in, then
    // the real inbound message routes through the shared nlp engine and the
    // reply is a REAL Bot API sendMessage (metaMock tg.calls).
    const { tg } = await import("../metaMock");
    const sendsToChat = () => tg.callsFor("sendMessage").filter((c: any) => String(c.body?.chat_id) === chatId);
    let res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(903501, chatId, fromId, "/start"));
    assert(res.status === 200, "tg /start ack");
    await world.waitFor(() => sendsToChat().length > 0, 5000, "tg opt-in confirmation");
    const beforeCancel = sendsToChat().length;

    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(903502, chatId, fromId, "cancel subscription"));
    assert(res.status === 200, `TG cancel accepted (got ${res.status})`);
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.customerSubscriptions)
        .where(and(eq(schema.customerSubscriptions.tenantId, TENANT_ID), eq(schema.customerSubscriptions.customerId, phone3)))
        .orderBy(desc(schema.customerSubscriptions.createdAt)).limit(1);
      return rows[0]?.status === "cancelled";
    }, 10000, "telegram cancel flipped the subscription");
    await world.waitFor(() => sendsToChat().length > beforeCancel, 5000, "tg cancel reply sent");
    const tgLast = String(sendsToChat().at(-1)!.body?.text ?? "");
    assertIncludes(tgLast, "cancelled", "telegram cancel confirmation text");
    const audit: any[] = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND action = 'subscription.cancelled' ORDER BY created_at DESC LIMIT 1`,
    )) as any;
    assert((Array.isArray(audit) ? audit : []).length > 0, "cancel audit row");

    // Cancelled sub cannot be paused (state machine honesty).
    await world.text(phone3, "pause subscription");
    const noneLeft = bodyText(world.outbound.lastOfType("text", phone3));
    assertIncludes(noneLeft, "couldn't find", "cancelled sub not pausable");
  },
};
