/**
 * J86 — Broadcast journeys: an opted-in customer enters a journey → the
 * welcome template is sent on the first tick → the run parks on
 * wait_for_reply → the customer's reply advances the run → it completes.
 *
 * Drives the REAL stack: journeys router (create/activate/enroll) and the
 * /api/scheduled/journey-tick cron endpoint (runDueJourneySteps).
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

async function runRow(world: World, journeyId: string) {
  const schema = await import("../../drizzle/schema");
  const [row] = await world.db
    .select()
    .from(schema.broadcastJourneyRuns)
    .where(and(eq(schema.broadcastJourneyRuns.journeyId, journeyId), eq(schema.broadcastJourneyRuns.tenantId, TENANT_ID)))
    .limit(1);
  return row ?? null;
}

export const journey: Journey = {
  id: "J86",
  name: "broadcast journey lifecycle",
  feature: "enroll → template → reply advances → done",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const caller = await adminCaller();
    const phone = world.newPhone("j86");

    // Wall-clock independent: disable marketing quiet hours for this journey
    // (the default 21:00–08:00 Africa/Lagos window would otherwise defer the
    // first send). Restored at the end.
    const origSettings = await world.tenantSettings();
    await world.patchTenantSettings({ marketingFrequency: { quietStart: "00:00", quietEnd: "00:00" } });

    // Opted-in customer (journey sends are consent-gated).
    await world.db.insert(schema.customers).values({
      id: `cust-${phone}`, tenantId: TENANT_ID, whatsappPhone: phone, name: "J86 Ada",
    }).onConflictDoNothing();
    await world.grantConsent(phone);

    // ── Build + activate the journey ─────────────────────────────────────
    const steps = [
      { id: "s1", type: "send_template", templateName: "sim_broadcast", languageCode: "en_US" },
      { id: "s2", type: "wait_for_reply", timeoutMinutes: 60 * 24, onReplyStepId: "s3", onTimeoutStepId: "s4" },
      { id: "s3", type: "exit" },
      { id: "s4", type: "exit" },
    ];
    const { id: journeyId } = await caller.journeys.create({
      tenantId: TENANT_ID,
      name: "J86 Welcome Journey",
      steps,
    });
    assert(journeyId, "journey created");

    // Draft journeys don't run: activation validates + flips status.
    await caller.journeys.setStatus({ journeyId, status: "active" });

    const enr = await caller.journeys.enroll({ journeyId, customerIds: [`cust-${phone}`] });
    assert(enr.enrolled === 1, "one run enrolled");
    const r0 = await runRow(world, journeyId);
    assert(r0?.state === "waiting" && r0.currentStep === 0, "run parked at step 0");

    // ── Tick 1: welcome template sent, run advances to wait_for_reply ────
    const t1 = await world.runCron("/api/scheduled/journey-tick");
    assert(t1.status === 200, `journey tick cron ok (got ${t1.status})`);
    const tpl = world.outbound.toPhone(phone).find((c) => c.waType === "template");
    assert(tpl, "welcome template was sent to the enrolled customer");
    const r1 = await runRow(world, journeyId);
    assert(r1?.state === "waiting" && r1.currentStep === 1, `run parked on wait_for_reply (got step ${r1?.currentStep})`);

    // ── Customer replies → tick 2 advances to the on_reply branch ────────
    await world.text(phone, "tell me more");
    // The run parks on a 5-minute reply poll; make it due again immediately.
    await world.backdate(
      `UPDATE broadcast_journey_runs SET "nextRunAt" = NOW() - INTERVAL '1 minute' WHERE "journeyId" = $1`,
      [journeyId],
    );
    const t2 = await world.runCron("/api/scheduled/journey-tick");
    assert(t2.status === 200, "second tick ok");
    const r2 = await runRow(world, journeyId);
    assert(r2?.state === "done", `run completed after the reply (got ${r2?.state})`);
    assert((r2?.context as any)?.exitStep === "s3", "completed via the on_reply branch");

    await world.patchTenantSettings({ marketingFrequency: origSettings.marketingFrequency ?? null });
  },
};
