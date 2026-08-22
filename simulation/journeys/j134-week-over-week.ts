/**
 * J134 — W27 bookkeeping: week-over-week (and day-over-day) math.
 * Boundary-focused: orders exactly on period edges, zero-baseline periods,
 * down/flat trends, and daily vs weekly window lengths. All integer cents.
 */
import crypto from "crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J134",
  name: "week-over-week math",
  feature: "W27 bookkeeping summaries",
  async run(world) {
    // Lazy import: top-level service imports would freeze server/_core/env
    // before bootWorld() points LLM/media URLs at the sim mocks.
    const { computeSalesSummary, periodRange, renderDigestMessage } = await import("../../server/services/bookkeeping");
    const schema = await import("../../drizzle/schema");
    const now = new Date();
    const week = periodRange("weekly", now);
    // Dedicated tenant id: orders are NOT wiped between journeys, so WoW
    // math must be isolated from other journeys' seeded orders.
    const WOW_TENANT = `wow-${crypto.randomUUID().slice(0, 8)}`;
    const mk = async (at: Date, total: string) => {
      await world.db.insert(schema.orders).values({
        id: crypto.randomUUID(), tenantId: WOW_TENANT, customerId: "c-wow",
        orderNumber: `WOW-${crypto.randomUUID().slice(0, 8)}`, status: "delivered",
        totalAmount: total, currency: "NGN", paymentStatus: "completed",
        createdAt: at, updatedAt: at,
      });
    };

    // ── Up 12%: this week ₦42,300 vs last week ₦37,767 ──────────────────
    await mk(new Date(week.from.getTime() + 1000), "42300.00");
    await mk(new Date(week.prevFrom.getTime() + 1000), "37767.00");
    let s = await computeSalesSummary(world.db, WOW_TENANT, "weekly", now);
    assert(s.salesCents === 4230000, `this-week cents (${s.salesCents})`);
    assert(s.prevSalesCents === 3776700, `last-week cents (${s.prevSalesCents})`);
    assert(s.changePct === 12, `up 12% (got ${s.changePct})`);
    assert(renderDigestMessage(s).includes("up 12%"), "digest renders up 12%");

    // ── Boundary: an order at exactly `to` (midnight tomorrow) belongs to
    //    NEXT period, and one at exactly prevTo belongs to THIS period ────
    await mk(new Date(week.to.getTime()), "10000.00");            // excluded
    await mk(new Date(week.prevTo.getTime()), "5000.00");         // included (>= from)
    s = await computeSalesSummary(world.db, WOW_TENANT, "weekly", now);
    assert(s.salesCents === 4730000, `boundary inclusion (${s.salesCents})`);

    // ── Daily window vs yesterday ────────────────────────────────────────
    const day = periodRange("daily", now);
    await mk(new Date(day.prevFrom.getTime() + 1000), "1000.00"); // yesterday
    const d = await computeSalesSummary(world.db, WOW_TENANT, "daily", now);
    assert(d.prevSalesCents === 100000, `yesterday cents (${d.prevSalesCents})`);
    assert(d.periodKey.startsWith("D"), "daily period key");

    // ── Zero-baseline: a fresh tenant with sales only this week → null ──
    const fresh = `fresh-${crypto.randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.orders).values({
      id: crypto.randomUUID(), tenantId: fresh, customerId: "c-fresh",
      orderNumber: `WOW-F-${crypto.randomUUID().slice(0, 6)}`, status: "delivered",
      totalAmount: "800.00", currency: "NGN", paymentStatus: "completed",
      createdAt: new Date(week.from.getTime() + 1000), updatedAt: new Date(week.from.getTime() + 1000),
    });
    const z = await computeSalesSummary(world.db, fresh, "weekly", now);
    assert(z.salesCents === 80000, "fresh-tenant sales");
    assert(z.prevSalesCents === 0, "fresh-tenant no baseline");
    assert(z.changePct === null, "changePct null with zero baseline");
    assert(renderDigestMessage(z).includes("no sales last week to compare"), "digest handles zero baseline");

    // ── Down trend: previous > current ───────────────────────────────────
    const down = `down-${crypto.randomUUID().slice(0, 8)}`;
    const mkFor = async (tenant: string, at: Date, total: string) => {
      await world.db.insert(schema.orders).values({
        id: crypto.randomUUID(), tenantId: tenant, customerId: "c-down",
        orderNumber: `WOW-D-${crypto.randomUUID().slice(0, 6)}`, status: "delivered",
        totalAmount: total, currency: "NGN", paymentStatus: "completed",
        createdAt: at, updatedAt: at,
      });
    };
    await mkFor(down, new Date(week.from.getTime() + 1000), "100.00");
    await mkFor(down, new Date(week.prevFrom.getTime() + 1000), "400.00");
    const ds = await computeSalesSummary(world.db, down, "weekly", now);
    assert(ds.changePct === -75, `down 75% (got ${ds.changePct})`);
    assert(renderDigestMessage(ds).includes("down 75% vs last week"), "digest renders down trend");
  },
};
