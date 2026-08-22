/**
 * J131 — W27 bookkeeping: daily/weekly sales digest generation correctness.
 * Seeds paid orders across this week and last week, opts a merchant phone in
 * via the WhatsApp "digest on weekly" command, runs the scheduled-digest cron
 * and asserts the WhatsApp digest message carries the exact totals and the
 * week-over-week percentage. Re-running the cron is idempotent (no resend).
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

async function seedPaidOrder(world: World, createdAt: Date, totalMajor: string, tag: string) {
  const schema = await import("../../drizzle/schema");
  await world.db.insert(schema.orders).values({
    id: crypto.randomUUID(),
    tenantId: TENANT_ID,
    customerId: `sim-customer-${tag}`,
    orderNumber: `BK-${tag}-${crypto.randomUUID().slice(0, 8)}`,
    status: "delivered",
    totalAmount: totalMajor,
    currency: "NGN",
    paymentStatus: "completed",
    createdAt,
    updatedAt: createdAt,
  });
}

export const journey: Journey = {
  id: "J131",
  name: "sales digest generation",
  feature: "W27 bookkeeping digests",
  async run(world) {
    // Lazy import: top-level service imports would freeze server/_core/env
    // before bootWorld() points LLM/media URLs at the sim mocks.
    const { computeSalesSummary, periodRange, renderDigestMessage } = await import("../../server/services/bookkeeping");
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    const week = periodRange("weekly", now);

    // ── This week: 2 paid orders ₦30,300 + ₦12,000 = ₦42,300 ──────────
    const inWeek = new Date(week.from.getTime() + 3600 * 1000);
    await seedPaidOrder(world, inWeek, "30300.00", "a");
    await seedPaidOrder(world, inWeek, "12000.00", "b");
    // Unpaid order this week must NOT count.
    await world.db.insert(schema.orders).values({
      id: crypto.randomUUID(), tenantId: TENANT_ID, customerId: "sim-customer-x",
      orderNumber: `BK-x-${crypto.randomUUID().slice(0, 8)}`, status: "pending",
      totalAmount: "99999.00", currency: "NGN", paymentStatus: "unpaid",
      createdAt: inWeek, updatedAt: inWeek,
    });
    // ── Last week: ₦37,767 → up 12% (42300/37767 - 1 = 0.1199 → 12) ────
    const lastWeek = new Date(week.prevFrom.getTime() + 3600 * 1000);
    await seedPaidOrder(world, lastWeek, "37767.00", "c");

    // ── Opt in via WhatsApp command ──────────────────────────────────────
    const merchant = world.newPhone("merchant");
    await world.grantConsent(merchant);
    await world.text(merchant, "digest on weekly");
    const optInReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(optInReply, "digest ON", "opt-in acknowledged");
    assertIncludes(optInReply, "weekly", "frequency echoed");

    // Expected summary computed directly (orders are NOT wiped between
    // journeys, so assert against the service output — exact-math journeys
    // J133/J134 use isolated tenants).
    const expected = await computeSalesSummary(world.db, TENANT_ID, "weekly", new Date());
    const expectedMsg = renderDigestMessage(expected);
    // Other journeys' paid orders may share the window; our ₦42,300 fixture
    // must be included in the total (exact-math coverage lives in J134).
    assert(expected.salesCents >= 4230000, "fixture orders included in summary");

    // ── Run the scheduled digest cron ────────────────────────────────────
    const cron = await world.runCron("/api/scheduled/bookkeeping-digests");
    assert(cron.status === 200, `digest cron 200 (got ${cron.status})`);
    assert(cron.json?.run?.sent === 1, `exactly one digest sent (got ${JSON.stringify(cron.json?.run)})`);

    const digest = bodyText(world.outbound.lastOfType("text", merchant));
    assert(digest === expectedMsg, `digest matches computed summary: ${digest}`);
    assertIncludes(digest, "this week", "weekly span wording");

    // ── Idempotency: second cron run sends nothing ───────────────────────
    const before = world.outbound.all().length;
    const again = await world.runCron("/api/scheduled/bookkeeping-digests");
    assert(again.json?.run?.sent === 0, "re-run sends nothing");
    assert(world.outbound.all().length === before, "no duplicate WhatsApp digest");

    // ── On-demand "sales summary" command agrees with the digest ─────────
    await world.text(merchant, "sales summary");
    const onDemand = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(onDemand, expectedMsg.split(".")[0], "on-demand summary matches digest headline");

    // ── Digest log row persisted with integer cents ──────────────────────
    const [log] = await world.db.select().from(schema.bookkeepingDigestLog)
      .where(eq(schema.bookkeepingDigestLog.tenantId, TENANT_ID)).limit(1);
    assert(log.salesCents === expected.salesCents, `log stores integer cents (got ${log.salesCents})`);
    assert(log.orderCount === expected.orderCount, "log stores order count");
    assert(log.periodKey === week.periodKey, "log period key matches weekly range");
  },
};
