/**
 * J87 — Frequency-cap-aware journeys + consent withdrawal:
 *   (a) a customer already at the marketing frequency cap (2 sends in 7d)
 *       has their journey send DEFERRED (run stays waiting, nextRunAt in the
 *       future, nothing sent) instead of spamming them;
 *   (b) a consent withdrawal mid-journey EXITS the run on the next tick
 *       (state='exited', exitReason='consent_withdrawn', nothing sent).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

async function runFor(world: World, journeyId: string, customerId: string) {
  const schema = await import("../../drizzle/schema");
  const [row] = await world.db
    .select()
    .from(schema.broadcastJourneyRuns)
    .where(and(
      eq(schema.broadcastJourneyRuns.journeyId, journeyId),
      eq(schema.broadcastJourneyRuns.customerId, customerId),
    ))
    .limit(1);
  return row ?? null;
}

export const journey: Journey = {
  id: "J87",
  name: "journey frequency cap + withdrawal",
  feature: "cap defers send; withdrawal exits run",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();

    // Deterministic scheduling: disable quiet hours (frequency cap stays on).
    const origSettings = await world.tenantSettings();
    await world.patchTenantSettings({ marketingFrequency: { quietStart: "00:00", quietEnd: "00:00" } });

    try {
      const phoneA = world.newPhone("j87a"); // capped customer
      const phoneB = world.newPhone("j87b"); // withdrawing customer
      for (const [phone, name] of [[phoneA, "Capped Chidi"], [phoneB, "Withdrawing Wale"]] as const) {
        await world.db.insert(schema.customers).values({
          id: `cust-${phone}`, tenantId: TENANT_ID, whatsappPhone: phone, name,
        }).onConflictDoNothing();
        await world.grantConsent(phone);
      }

      // Customer A is AT the marketing cap: 2 broadcast sends in the last 7d.
      const now = new Date();
      for (const hoursAgo of [5, 30]) {
        await world.db.insert(schema.whatsappNotificationLog).values({
          tenantId: TENANT_ID,
          phone: phoneA,
          notifType: "broadcast",
          templateName: "sim_broadcast",
          status: "sent",
          sentAt: new Date(now.getTime() - hoursAgo * 3600_000),
        });
      }

      const { id: journeyId } = await caller.journeys.create({
        tenantId: TENANT_ID,
        name: "J87 Cap + Withdrawal",
        steps: [
          { id: "s1", type: "send_template", templateName: "sim_broadcast", languageCode: "en_US" },
          { id: "s2", type: "exit" },
        ],
      });
      await caller.journeys.setStatus({ journeyId, status: "active" });
      const enr = await caller.journeys.enroll({ journeyId, customerIds: [`cust-${phoneA}`, `cust-${phoneB}`] });
      assert(enr.enrolled === 2, "both customers enrolled");

      // ── (a) frequency cap: A's tick defers instead of sending ──────────
      const outboundBefore = world.outbound.toPhone(phoneA).length;
      const t1 = await world.runCron("/api/scheduled/journey-tick");
      assert(t1.status === 200, "tick 1 ok");
      const ra = await runFor(world, journeyId, `cust-${phoneA}`);
      assert(ra?.state === "waiting" && ra.currentStep === 0, "capped run still parked on step 0");
      assert(ra?.nextRunAt && new Date(ra.nextRunAt).getTime() > Date.now(), "capped run deferred into the future");
      assert(world.outbound.toPhone(phoneA).length === outboundBefore, "capped customer received nothing");

      // B was under the cap → got the template and completed.
      const rb1 = await runFor(world, journeyId, `cust-${phoneB}`);
      assert(rb1?.state === "done", `uncapped run completed (got ${rb1?.state})`);

      // ── (b) consent withdrawal mid-journey exits the run ───────────────
      // Re-enroll B (fresh run parked at step 0), then withdraw consent.
      await caller.journeys.enroll({ journeyId, customerIds: [`cust-${phoneB}`] });
      const wd = await caller.consents.recordWithdrawal({ tenantId: TENANT_ID, phone: phoneB });
      assert(wd.withdrawnAt, "withdrawal recorded with a timestamp");

      const bTplBefore = world.outbound.toPhone(phoneB).filter((c) => c.waType === "template").length;
      await world.runCron("/api/scheduled/journey-tick");
      const runsB = await world.db
        .select()
        .from(schema.broadcastJourneyRuns)
        .where(and(
          eq(schema.broadcastJourneyRuns.journeyId, journeyId),
          eq(schema.broadcastJourneyRuns.customerId, `cust-${phoneB}`),
          eq(schema.broadcastJourneyRuns.state, "exited"),
        ));
      assert(runsB.length === 1, "withdrawn customer's second run exited");
      assert((runsB[0].context as any)?.exitReason === "consent_withdrawn", "exit reason = consent_withdrawn");
      assert(
        world.outbound.toPhone(phoneB).filter((c) => c.waType === "template").length === bTplBefore,
        "withdrawn customer received no further templates",
      );

      // The withdrawal row is visible to the tenant with a withdrawnAt stamp.
      const listed = await caller.consents.list({ tenantId: TENANT_ID });
      const rowB = (listed as any[]).find((r) => r.phone === phoneB);
      assert(rowB?.withdrawnAt, "consent list surfaces the withdrawal");
    } finally {
      await world.patchTenantSettings({ marketingFrequency: origSettings.marketingFrequency ?? null });
    }
  },
};
