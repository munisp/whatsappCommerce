// === W66 learning ===
/**
 * J630 — R6 buyer-side proactive reorder nudge (restockIntel.runBuyerReorderNudges):
 *   1. A buyer with a repeat-purchase cadence (3 paid orders of the same
 *      product, last purchase older than the mean interval) gets ONE
 *      "running low on X?" nudge with a REORDER hint (cart rebuild lives in
 *      reorder.ts, exercised by J12).
 *   2. A buyer whose cadence has NOT elapsed is skipped.
 *   3. Same-week re-run sends 0 (ISO-week claim), a later week sends again.
 */
import { sql } from "drizzle-orm";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

const BUYER = "2348063000001";

export const journey: Journey = {
  id: "J630",
  name: "buyer reorder nudge from cadence; weekly idempotency",
  feature: "W66 R6 buyer-side proactive reorder",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/restockIntel");
    const now = new Date();

    // Quiet hours disabled so the sweep is time-of-day independent (J621 pattern).
    const before = await world.tenantSettings();
    await world.patchTenantSettings({
      marketingFrequency: { ...(before?.marketingFrequency ?? {}), quietStart: "00:00", quietEnd: "00:00" },
    });

    // ── Seeds: 3 completed orders of the same product, 7-day cadence ────
    // Purchases at now-21d, now-14d, now-8d → interval 6.5d, elapsed 8d.
    const offsetsDays = [21, 14, 8];
    for (let i = 0; i < offsetsDays.length; i++) {
      await world.db.insert(schema.orders).values({
        id: `o-j630-${i}`, tenantId: TENANT_ID, customerId: BUYER, orderNumber: `SIM-J630-${i}`,
        status: "delivered", totalAmount: "50.00", currency: "NGN", paymentStatus: "completed",
      }).onConflictDoNothing();
      await world.db.execute(sql`
        UPDATE orders SET "createdAt" = now() - (${offsetsDays[i]} * interval '1 day') WHERE id = ${`o-j630-${i}`}
      `);
      await world.db.insert(schema.orderItems).values({
        id: `oi-j630-${i}`, orderId: `o-j630-${i}`, productId: "p-j630",
        productName: "J630 Milk", quantity: 2, unitPrice: "25.00", currency: "NGN",
      }).onConflictDoNothing();
    }
    // A second buyer whose last purchase is too recent (cadence not elapsed).
    await world.db.insert(schema.orders).values([
      { id: "o-j630-r1", tenantId: TENANT_ID, customerId: "buyer-recent", orderNumber: "SIM-J630-R1", status: "delivered", totalAmount: "50.00", currency: "NGN", paymentStatus: "completed" },
      { id: "o-j630-r2", tenantId: TENANT_ID, customerId: "buyer-recent", orderNumber: "SIM-J630-R2", status: "delivered", totalAmount: "50.00", currency: "NGN", paymentStatus: "completed" },
    ]).onConflictDoNothing();
    await world.db.execute(sql`UPDATE orders SET "createdAt" = now() - interval '30 days' WHERE id = 'o-j630-r1'`);
    await world.db.execute(sql`UPDATE orders SET "createdAt" = now() - interval '1 day' WHERE id = 'o-j630-r2'`);
    await world.db.insert(schema.orderItems).values([
      { id: "oi-j630-r1", orderId: "o-j630-r1", productId: "p-j630", productName: "J630 Milk", quantity: 1, unitPrice: "25.00", currency: "NGN" },
      { id: "oi-j630-r2", orderId: "o-j630-r2", productId: "p-j630", productName: "J630 Milk", quantity: 1, unitPrice: "25.00", currency: "NGN" },
    ]).onConflictDoNothing();

    // Claims are asserted per-buyer (proactive_nudges rows) because the full
    // shared world contains other journeys' paid orders whose cadence becomes
    // eligible at the +7d run — global nudge counts are not stable there.
    const weekOf = (d: Date) => {
      const m = new Date(d);
      m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
      return m.toISOString().slice(0, 10);
    };
    const claims = async (buyer: string) => {
      const res: any = await world.db.execute(sql`
        SELECT day FROM proactive_nudges
        WHERE tenant_id = ${TENANT_ID} AND nudge_type = 'buyer_reorder'
          AND subject_id = ${`${buyer}:J630 Milk`}
      `);
      return ((res?.rows ?? res) as any[]).map((r) => String(r.day));
    };

    // ── First run: the cadence buyer is nudged (claim for this week) ─────
    const r1 = await svc.runBuyerReorderNudges({ now });
    assert(r1.nudgesSent >= 1, `nudges ${r1.nudgesSent}`);
    assert((await claims(BUYER)).includes(weekOf(now)), "cadence buyer claimed this week");
    assert((await claims("buyer-recent")).length === 0, "recent buyer must NOT be nudged");

    // ── Same-week re-run: no NEW claims for our buyers ───────────────────
    const r2 = await svc.runBuyerReorderNudges({ now });
    assert(r2.nudgesSent === 0, `same-week rerun ${r2.nudgesSent}`);
    assert((await claims(BUYER)).length === 1, "still exactly one claim");

    // ── Next week: the cadence buyer is nudged again (new week claim) ───
    const nextWeek = new Date(now.getTime() + 7 * 24 * 3600_000);
    assert(weekOf(nextWeek) !== weekOf(now), "+7d crosses an ISO week boundary");
    const r3 = await svc.runBuyerReorderNudges({ now: nextWeek });
    assert(r3.nudgesSent >= 1, `next-week rerun ${r3.nudgesSent}`);
    assert((await claims(BUYER)).includes(weekOf(nextWeek)), "cadence buyer claimed next week");
    assert((await claims("buyer-recent")).length === 0, "recent buyer still not nudged");
  },
};
