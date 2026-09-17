// === W44 deposits-subs-digital (Coder C) ===
/**
 * J349 — Subscription auto-billing success path:
 *  plan (tRPC createPlan) + saved fake W41 token → subscribe with a DUE
 *  nextBillingAt → cron tick (/api/scheduled/subscription-billing, scoped
 *  cron JWT) charges the token claim-first (ref sub_billing:<sub>:<period>)
 *  → order + order line created and next_billing_at advanced in the SAME
 *  txn → receipt sent BOTH channels (telegram via identity binding).
 *  Re-running the tick does NOT double-charge (period idempotency).
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedFakeToken, bindTelegram } from "./w44-seed";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J349",
  name: "subscription billing tick charges + advances + idempotent",
  feature: "customer_subscriptions + claim-first charge + order leg + parity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();

    // Plan over the REAL tRPC surface.
    const plan = await caller.subscriptionPlans.createPlan({
      tenantId: TENANT_ID,
      productId: "p-jollof",
      name: "Jollof Weekly Box",
      interval: "week",
      priceCents: 250_000,
    });
    assert(plan.id, "plan created");

    const phone = world.newPhone("j349");
    await world.grantConsent(phone);
    const tokenId = await seedFakeToken(world, phone);

    const { subscribeCustomer, periodKey, subBillingRef, advanceInterval } = await import("../../server/services/subscriptions");
    const dueAt = new Date(Date.now() - 60_000); // due 1 min ago
    const sub = await subscribeCustomer(world.db, {
      tenantId: TENANT_ID,
      planId: plan.id,
      customerRef: phone,
      paymentTokenId: tokenId,
      nextBillingAt: dueAt,
    });
    assert(sub.status === "active", "sub active");

    // Telegram parity: bind a chat id; capture channelSender deliveries.
    const chatId = "j349chat";
    await bindTelegram(world, phone, chatId);
    const parity = await import("../../server/services/channelParity");
    const tgSeen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p) => {
      tgSeen.push({ channel, to, ...(p as any) });
      return { sent: true, simulated: false };
    });

    try {
      // ── Tick 1: charge happens ──
      const tick = await world.runCron("/api/scheduled/subscription-billing");
      assert(tick.status === 200, `tick accepted (got ${tick.status}: ${JSON.stringify(tick.json)})`);
      assert(tick.json.ok === true, "tick ok");
      assert(tick.json.charged >= 1, `charged >= 1 (got ${JSON.stringify(tick.json)})`);

      const [after] = await world.db.select().from(schema.customerSubscriptions)
        .where(eq(schema.customerSubscriptions.id, sub.id));
      const period = periodKey(dueAt);
      assert(after.lastBilledPeriod === period, `period marker ${period} (got ${after.lastBilledPeriod})`);
      assert(after.lastChargeRef === subBillingRef(sub.id, period), `idempotent charge ref (got ${after.lastChargeRef})`);
      const expectedNext = advanceInterval(dueAt, "week");
      assert(Math.abs(after.nextBillingAt.getTime() - expectedNext.getTime()) < 1000,
        `nextBillingAt advanced one week (got ${after.nextBillingAt.toISOString()})`);
      assert(after.retryCount === 0, "retry reset");

      // Order leg created in the same txn.
      const subOrders = await world.db.select().from(schema.orders)
        .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)));
      const subOrder = subOrders.find((o: any) => String(o.orderNumber).startsWith("SUB-"));
      assert(subOrder, "subscription order created");
      assert(subOrder.paymentStatus === "completed" && subOrder.status === "confirmed", "order paid+confirmed");
      assert(subOrder.totalAmount === "2500.00", `order total 2500.00 (got ${subOrder.totalAmount})`);
      const lines = await world.db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, subOrder.id));
      assert(lines.length === 1 && lines[0].productId === "p-jollof", "order line for the plan product");

      // Receipt reached the telegram-bound customer via channelSender.
      await world.waitFor(() => tgSeen.some((c) => c.channel === "telegram" && c.to === chatId && JSON.stringify(c).includes("subscription payment")),
        10000, "telegram receipt delivered");

      // ── Tick 2 (same period clock): NO double charge / double order ──
      const ordersBefore = (await world.db.select().from(schema.orders)
        .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)))).length;
      const tick2 = await world.runCron("/api/scheduled/subscription-billing");
      assert(tick2.status === 200, "second tick accepted");
      const ordersAfter = (await world.db.select().from(schema.orders)
        .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)))).length;
      assert(ordersAfter === ordersBefore, `no double order (${ordersBefore} → ${ordersAfter})`);
      const [after2] = await world.db.select().from(schema.customerSubscriptions).where(eq(schema.customerSubscriptions.id, sub.id));
      assert(after2.nextBillingAt.getTime() === after.nextBillingAt.getTime(), "nextBillingAt not advanced twice");
    } finally {
      parity.__setChannelSenderForTests(null);
    }

    // WA buyer on the same plan gets the WA-path receipt (channelParity leaves WA to the caller).
    const waPhone = world.newPhone("j349wa");
    await world.grantConsent(waPhone);
    const waToken = await seedFakeToken(world, waPhone);
    await subscribeCustomer(world.db, {
      tenantId: TENANT_ID, planId: plan.id, customerRef: waPhone,
      paymentTokenId: waToken, nextBillingAt: new Date(Date.now() - 30_000),
    });
    const tick3 = await world.runCron("/api/scheduled/subscription-billing");
    assert(tick3.json.charged >= 1, "WA sub charged");
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", waPhone);
      return !!t && bodyText(t).includes("subscription payment");
    }, 10000, "WA receipt delivered");
    const waReceipt = bodyText(world.outbound.lastOfType("text", waPhone));
    assertIncludes(waReceipt, "₦2,500.00", "receipt amount");
    assertIncludes(waReceipt, "pause subscription", "receipt advertises chat controls");
  },
};
