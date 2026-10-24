// === W64 intelligence ===
/**
 * J621 — R9 proactive push ops (services/proactive.ts):
 *   1. Seeds: low-stock product, aging pending order, due installment
 *      schedule entry, grade-A buyer credit score.
 *   2. runProactiveNudges sends one nudge per type (claim-first insert).
 *   3. A SECOND run on the same UTC day sends 0 — idempotent via
 *      proactive_nudges (tenant,type,subject,day) ON CONFLICT DO NOTHING.
 *   4. Scheduler parity (J615 pattern): /api/scheduled/proactive-nudges is
 *      a registered cron-auth route AND in the scheduler allowlist.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUYER_PHONE = "2348062100001";

export const journey: Journey = {
  id: "J621",
  name: "proactive nudges: 4 types sent, second sweep idempotent, scheduler allowlist parity",
  feature: "W64 intelligence R9: proactive push ops sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { runProactiveNudges } = await import("../../server/services/proactive");
    const before = await world.tenantSettings();
    try {
      // Quiet hours disabled so the sweep is time-of-day independent.
      await world.patchTenantSettings({
        marketingFrequency: { ...(before?.marketingFrequency ?? {}), quietStart: "00:00", quietEnd: "00:00" },
      });

      // ── 1. Seeds ───────────────────────────────────────────────────────
      await world.db.insert(schema.products).values({
        id: "p-j621-low", tenantId: TENANT_ID, sku: "SIM-J621-LOW", name: "J621 Low Stock Soap",
        price: "1.50", currency: "NGN", status: "active", stockQuantity: 2, lowStockThreshold: 10,
      }).onConflictDoNothing();
      await world.db.insert(schema.orders).values({
        id: "o-j621-aging", tenantId: TENANT_ID, customerId: "c-j621", orderNumber: "SIM-J621-1",
        status: "pending", totalAmount: "10.00", currency: "NGN", paymentStatus: "unpaid",
      }).onConflictDoNothing();
      await world.db.execute(`UPDATE orders SET "createdAt" = now() - interval '30 hours' WHERE id = 'o-j621-aging'`);
      const dueAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      await world.db.insert(schema.buyerInstallmentPlans).values({
        tenantId: TENANT_ID,
        orderId: "o-j621-aging",
        buyerPhone: BUYER_PHONE,
        totalCents: 1_000_000,
        downPaymentCents: 500_000,
        downPaymentRef: "j621-down-ref",
        downPaymentPaidAt: new Date(),
        installments: 2,
        schedule: [{ seq: 2, dueAt, amountCents: 500_000, status: "pending" }],
        currency: "NGN",
        status: "active",
      }).onConflictDoNothing();
      await world.db.insert(schema.creditScores).values({
        tenantId: TENANT_ID,
        subjectType: "buyer",
        subjectId: BUYER_PHONE,
        score: 820,
        grade: "A",
        factors: { source: "j621" },
      }).onConflictDoNothing();

      // ── 2. First sweep: one nudge per type ─────────────────────────────
      const run1 = await runProactiveNudges();
      assert(run1.lowStock >= 1, `low-stock nudge sent (got ${JSON.stringify(run1)})`);
      assert(run1.orderAging >= 1, `order-aging nudge sent (got ${JSON.stringify(run1)})`);
      assert(run1.paymentDue >= 1, `payment-due nudge sent (got ${JSON.stringify(run1)})`);
      assert(run1.creditOffer >= 1, `credit-offer nudge sent (got ${JSON.stringify(run1)})`);
      const claims = await world.db.select().from(schema.proactiveNudges)
        .where(eq(schema.proactiveNudges.tenantId, TENANT_ID));
      for (const [type, subject] of [
        ["low_stock", "p-j621-low"],
        ["order_aging", "o-j621-aging"],
        ["credit_offer", BUYER_PHONE],
      ] as const) {
        assert(claims.some((c: any) => c.nudgeType === type && c.subjectId === subject),
          `claim row for ${type}/${subject} (got ${JSON.stringify(claims.map((c: any) => [c.nudgeType, c.subjectId]))})`);
      }
      assert(claims.some((c: any) => c.nudgeType === "payment_due" && String(c.subjectId).endsWith(":2")),
        "claim row for payment_due installment seq 2");

      // ── 3. Second sweep same UTC day: idempotent — sends nothing ───────
      const run2 = await runProactiveNudges();
      assert(run2.lowStock === 0 && run2.orderAging === 0 && run2.paymentDue === 0 && run2.creditOffer === 0,
        `second sweep sends 0 (got ${JSON.stringify(run2)})`);

      // ── 4. Scheduler allowlist parity (J615 pattern) ───────────────────
      const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
      assert(idx.includes('app.post("/api/scheduled/proactive-nudges"'), "proactive-nudges route registered");
      assert(idx.includes('app.post("/api/scheduled/recs-refresh"'), "recs-refresh route registered");
      const scheduler = await import("../../services/scheduler/scheduler.mjs");
      for (const p of ["/api/scheduled/proactive-nudges", "/api/scheduled/recs-refresh"]) {
        assert(scheduler.SCHEDULE.some((x: { path: string }) => x.path === p), `scheduler allowlist entry for ${p}`);
      }
    } finally {
      await world.patchTenantSettings({ marketingFrequency: (before as any)?.marketingFrequency });
      await world.db.execute(`DELETE FROM proactive_nudges WHERE tenant_id = '${TENANT_ID}'`).catch(() => {});
      await world.db.execute(`DELETE FROM credit_scores WHERE tenant_id = '${TENANT_ID}' AND subject_id = '${BUYER_PHONE}'`).catch(() => {});
      await world.db.execute(`DELETE FROM buyer_installment_plans WHERE down_payment_ref = 'j621-down-ref'`).catch(() => {});
      await world.db.execute(`DELETE FROM order_items WHERE "orderId" = 'o-j621-aging'`).catch(() => {});
      await world.db.execute(`DELETE FROM orders WHERE id = 'o-j621-aging'`).catch(() => {});
      await world.db.execute(`DELETE FROM products WHERE id = 'p-j621-low'`).catch(() => {});
    }
  },
};
