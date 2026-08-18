/**
 * J111 (M6) — journey automation: a merchant-built win-back journey driven
 * by the journey-tick machinery end-to-end.
 *
 * Journey graph (validated by journeys.create):
 *   s1 send_template("sim_broadcast")
 *   s2 wait_for_reply(60m) ──reply──▶ s3 condition(has_tag "vip")
 *        └──timeout──▶ s9 exit         ├─true─▶ s4 send_template("sim_vip_j111") → s9
 *                                     └─false──────────────▶ s9
 *
 * Assertions:
 *   1. Lagos quiet hours respected: with the tenant policy at the default
 *      21:00–08:00 Africa/Lagos window, a tick executed at a quiet instant
 *      (injectable sim clock passed straight into runDueJourneySteps — no
 *      wall-clock flakiness) DEFERS the send to the 08:00 quiet end and
 *      nothing is delivered.
 *   2. The real /api/scheduled/journey-tick cron advances due runs: the
 *      win-back template is sent (frequency-cap-exempt customers), while a
 *      customer AT the marketing cap is deferred (run parked, nothing sent).
 *   3. A reply branches the run onto the VIP path (condition true → second
 *      template → exit, state done); the non-replier times out onto the
 *      exit path (state done, no VIP template).
 *
 * NOTE: services are imported LAZILY inside run() — loadJourneys() executes
 * before bootWorld() sets the sim env (see j101 header).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const HOUR = 60 * 60 * 1000;

/** Next future UTC instant that falls at 22:30 in Africa/Lagos (UTC+1). */
function nextLagosQuietInstant(from: Date): Date {
  // 22:30 Lagos == 21:30 UTC.
  const t = new Date(from);
  t.setUTCMinutes(30, 0, 0);
  t.setUTCHours(21);
  if (t.getTime() <= from.getTime()) t.setTime(t.getTime() + 24 * HOUR);
  return t;
}

async function runFor(world: World, journeyId: string, customerId: string) {
  const schema = await import("../../drizzle/schema");
  const rows = await world.db
    .select()
    .from(schema.broadcastJourneyRuns)
    .where(and(
      eq(schema.broadcastJourneyRuns.journeyId, journeyId),
      eq(schema.broadcastJourneyRuns.customerId, customerId),
    ));
  return rows[rows.length - 1] ?? null;
}

export const journey: Journey = {
  id: "J111",
  name: "journey automation — win-back flow (M6)",
  feature: "send_template→wait_for_reply→condition→exit via journey-tick cron; reply branches path; frequency cap + Lagos quiet hours respected (injectable sim clock)",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const origSettings = await world.tenantSettings();

    try {
      // Phase 1 policy: DEFAULT Lagos quiet hours (21:00–08:00), cap 2/7d.
      await world.patchTenantSettings({
        marketingFrequency: { maxPerWindow: 2, windowDays: 7, quietStart: "21:00", quietEnd: "08:00" },
      });

      // ── Cast ────────────────────────────────────────────────────────────
      const phoneA = world.newPhone("j111a"); // replier, vip tag
      const phoneB = world.newPhone("j111b"); // non-replier → timeout branch
      const phoneC = world.newPhone("j111c"); // at the marketing cap
      const mk = async (phone: string, name: string, tags: string[]) => {
        await world.db.insert(schema.customers).values({
          id: `cust-${phone}`, tenantId: TENANT_ID, whatsappPhone: phone, name, tags,
        }).onConflictDoNothing();
        await world.grantConsent(phone);
      };
      await mk(phoneA, "J111 Ada VIP", ["vip"]);
      await mk(phoneB, "J111 Bola Silent", []);
      await mk(phoneC, "J111 Capped Chika", []);

      // Second template for the VIP path.
      await world.db.insert(schema.whatsappTemplates).values({
        id: "wtpl-sim-j111-vip", tenantId: TENANT_ID, name: "sim_vip_j111",
        category: "custom", language: "en_US",
        bodyText: "VIP offer for you, {{1}}!",
        approvalStatus: "approved", isActive: true,
      }).onConflictDoNothing();

      // ── Build + activate + enroll ───────────────────────────────────────
      const { id: journeyId } = await caller.journeys.create({
        tenantId: TENANT_ID,
        name: "J111 Win-back Automation",
        steps: [
          { id: "s1", type: "send_template", templateName: "sim_broadcast", languageCode: "en_US" },
          { id: "s2", type: "wait_for_reply", timeoutMinutes: 60, onReplyStepId: "s3", onTimeoutStepId: "s9" },
          { id: "s3", type: "condition", condition: { kind: "has_tag", tag: "vip" }, onTrueStepId: "s4", onFalseStepId: "s9" },
          { id: "s4", type: "send_template", templateName: "sim_vip_j111", languageCode: "en_US" },
          { id: "s9", type: "exit" },
        ],
      });
      await caller.journeys.setStatus({ journeyId, status: "active" });

      // C is AT the marketing cap: 2 marketing sends inside the 7d window.
      const now0 = new Date();
      for (const hoursAgo of [5, 30]) {
        await world.db.insert(schema.whatsappNotificationLog).values({
          tenantId: TENANT_ID, phone: phoneC, notifType: "broadcast",
          templateName: "sim_broadcast", status: "sent",
          sentAt: new Date(now0.getTime() - hoursAgo * HOUR),
        });
      }

      const enr = await caller.journeys.enroll({ journeyId, customerIds: [`cust-${phoneA}`, `cust-${phoneB}`, `cust-${phoneC}`] });
      assert(enr.enrolled === 3, `three customers enrolled (got ${enr.enrolled})`);

      // ── 1. Quiet hours: a tick inside the Lagos quiet window defers ────
      // Injectable sim clock: run the tick at a FUTURE 22:30 Lagos instant
      // (all runs are due by then) — fully deterministic regardless of the
      // wall-clock time the suite happens to run.
      const { runDueJourneySteps } = await import("../../server/services/journeyBuilder");
      const { adjustForQuietHours, parseMarketingFrequencyPolicy, DEFAULT_MARKETING_FREQUENCY_POLICY } =
        await import("../../server/services/frequencyCap");
      const quietNow = nextLagosQuietInstant(new Date());
      const quietSummary = await runDueJourneySteps(quietNow);
      // (C's enroll-time nextRunAt is its cap release — days out — so only
      // the two uncapped runs are due at the quiet instant.)
      assert(quietSummary.deferred >= 2, `quiet-hours tick defers the due runs (got ${JSON.stringify(quietSummary)})`);
      assert(world.outbound.toPhone(phoneA).length === 0, "nothing sent inside quiet hours (A)");
      assert(world.outbound.toPhone(phoneB).length === 0, "nothing sent inside quiet hours (B)");
      const expectedAllowed = adjustForQuietHours(quietNow, parseMarketingFrequencyPolicy({ marketingFrequency: { quietStart: "21:00", quietEnd: "08:00" } }));
      assert(Math.abs(expectedAllowed.getTime() - adjustForQuietHours(quietNow, DEFAULT_MARKETING_FREQUENCY_POLICY).getTime()) < 1, "policy parse matches defaults");
      for (const phone of [phoneA, phoneB]) {
        const r = await runFor(world, journeyId, `cust-${phone}`);
        assert(r?.state === "waiting" && r.currentStep === 0, `run parked at step 0 (got ${r?.state}#${r?.currentStep})`);
        const nextAt = new Date(r!.nextRunAt as any).getTime();
        assert(Math.abs(nextAt - expectedAllowed.getTime()) < 60_000,
          `deferred to the 08:00 Lagos quiet end (got ${new Date(nextAt).toISOString()} vs ${expectedAllowed.toISOString()})`);
      }

      // ── 2. Cron journey-tick advances due runs (quiet hours lifted) ────
      // Advancement is asserted through the REAL cron endpoint; quiet hours
      // are disabled for this phase so the wall clock cannot flake the run.
      await world.patchTenantSettings({
        marketingFrequency: { maxPerWindow: 2, windowDays: 7, quietStart: "00:00", quietEnd: "00:00" },
      });
      // Reset the two uncapped runs to be due now.
      await world.db.update(schema.broadcastJourneyRuns)
        .set({ nextRunAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.broadcastJourneyRuns.journeyId, journeyId),
          eq(schema.broadcastJourneyRuns.state, "waiting"),
        ));

      const t1 = await world.runCron("/api/scheduled/journey-tick");
      assert(t1.status === 200 && t1.json?.ok === true, `journey-tick cron ok (got ${t1.status})`);
      assert(t1.json.processed >= 2, `cron processed the due runs (got ${JSON.stringify(t1.json)})`);

      await world.waitFor(
        () => world.outbound.toPhone(phoneA).some((c) => c.waType === "template"),
        8000, "win-back template delivered to A via the cron tick",
      );
      assert(world.outbound.toPhone(phoneB).some((c) => c.waType === "template"), "win-back template delivered to B");

      // Both runs now parked on the wait_for_reply step.
      for (const phone of [phoneA, phoneB]) {
        const r = await runFor(world, journeyId, `cust-${phone}`);
        assert(r?.state === "waiting" && r.currentStep === 1, `run parked on wait_for_reply (got ${r?.state}#${r?.currentStep})`);
      }

      // C: capped → still parked at step 0, nothing delivered.
      const rc = await runFor(world, journeyId, `cust-${phoneC}`);
      assert(rc?.state === "waiting" && rc.currentStep === 0, "capped run still parked on step 0");
      assert(rc?.nextRunAt && new Date(rc.nextRunAt).getTime() > Date.now(), "capped run deferred into the future");
      assert(world.outbound.toPhone(phoneC).length === 0, "capped customer received nothing");

      // ── 3a. Reply branches onto the VIP path ────────────────────────────
      await world.db.insert(schema.whatsappCustomerReplies).values({
        tenantId: TENANT_ID, fromPhone: phoneA, body: "yes I'm interested",
        wamid: "wamid-j111-reply-a", createdAt: new Date(),
      }).onConflictDoNothing();

      // A's wait_for_reply poll is parked 5m out — make it due now.
      const raPre = await runFor(world, journeyId, `cust-${phoneA}`);
      await world.db.update(schema.broadcastJourneyRuns)
        .set({ nextRunAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.broadcastJourneyRuns.id, raPre!.id));

      const t2 = await world.runCron("/api/scheduled/journey-tick");
      assert(t2.status === 200, "tick 2 ok");
      const ra = await runFor(world, journeyId, `cust-${phoneA}`);
      assert(ra?.state === "done", `replier run completed (got ${ra?.state})`);
      assert((ra?.context as any)?.exitStep === "s9", "replier exited via the exit step");
      assert(
        world.outbound.toPhone(phoneA).filter((c) => c.waType === "template").length === 2,
        "replier received the win-back + VIP templates (condition true branch)",
      );

      // ── 3b. Non-replier times out onto the exit path ────────────────────
      // Age B's wait_for_reply past the 60m timeout (deterministic clock
      // shift on the run context, then a real cron tick).
      const rb = await runFor(world, journeyId, `cust-${phoneB}`);
      const agedContext = { ...(rb?.context as any ?? {}), stepStartedAt: new Date(Date.now() - 2 * HOUR).toISOString() };
      await world.db.update(schema.broadcastJourneyRuns)
        .set({ context: agedContext, nextRunAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.broadcastJourneyRuns.id, rb!.id));

      const t3 = await world.runCron("/api/scheduled/journey-tick");
      assert(t3.status === 200, "tick 3 ok");
      const rb2 = await runFor(world, journeyId, `cust-${phoneB}`);
      assert(rb2?.state === "done", `non-replier run completed via timeout (got ${rb2?.state})`);
      assert(
        world.outbound.toPhone(phoneB).filter((c) => c.waType === "template").length === 1,
        "non-replier received only the win-back template (no VIP offer)",
      );
    } finally {
      await world.patchTenantSettings({ marketingFrequency: origSettings.marketingFrequency ?? null });
    }
  },
};
