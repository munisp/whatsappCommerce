/**
 * J151 — Stokvel missed-contribution handling.
 * A 2-member weekly circle: member A pays, member B goes silent. A pending
 * contribution first accrues auditable WhatsApp reminders (reminderCount
 * increments, capped); once the cycle window passes, the REAL
 * markMissedContributions scan flips it to 'missed' with an audit event.
 * Idempotence: the paid member's second contribution never double-counts,
 * and a missed member can no longer pay that cycle.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J151",
  name: "stokvel missed contribution",
  feature: "reminders + missed tracking + idempotent contribution",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const payer = world.newPhone("m1");
    const silent = world.newPhone("m2");
    await world.grantConsent(payer);
    await world.grantConsent(silent);

    const admin = await adminCaller();
    const { circle, members } = await admin.stokvel.createCircle({
      tenantId: TENANT_ID,
      name: "Missed Contrib Circle",
      contributionAmountCents: 20_000,
      frequency: "weekly",
      members: [{ phone: payer }, { phone: silent }],
    });
    const prefix = circle.id.slice(0, 8);

    // Member A contributes through WhatsApp — no payout yet (B outstanding).
    await world.text(payer, `stokvel contribute ${prefix}`);
    const ack = bodyText(world.outbound.lastOfType("text", payer));
    assert(ack.includes("Waiting on the other members"), `partial cycle waits (got: ${ack})`);
    let payouts = await world.db.select().from(schema.stokvelPayouts)
      .where(eq(schema.stokvelPayouts.circleId, circle.id));
    assert(payouts.length === 0, "no payout while a member is outstanding");

    // Idempotence: A paying again is acknowledged but never double-counted.
    await world.text(payer, `stokvel contribute ${prefix}`);
    const again = bodyText(world.outbound.lastOfType("text", payer));
    assert(again.includes("already recorded"), `idempotent re-contribution (got: ${again})`);
    let contribs = await world.db.select().from(schema.stokvelContributions)
      .where(eq(schema.stokvelContributions.circleId, circle.id));
    assert(contribs.filter((c: any) => c.status === "paid").length === 1, "still exactly one paid contribution");

    // ── Reminders: B's pending row accrues auditable reminder claims ─────
    const stokvel = await import("../../server/services/stokvel");
    const due1 = await stokvel.claimContributionReminders(world.db, { tenantId: TENANT_ID });
    const mine1 = due1.filter((r: any) => r.circleId === circle.id);
    assert(mine1.length === 1 && mine1[0].phone === silent, "reminder claimed for the silent member");
    assert(mine1[0].reminderCount === 1, "reminderCount incremented");
    const due2 = await stokvel.claimContributionReminders(world.db, { tenantId: TENANT_ID });
    assert(due2.find((r: any) => r.circleId === circle.id)?.reminderCount === 2, "second reminder increments again");

    // ── Missed: backdate B's row beyond the weekly window, run the scan ──
    await world.db.update(schema.stokvelContributions)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(and(
        eq(schema.stokvelContributions.circleId, circle.id),
        eq(schema.stokvelContributions.phone, silent),
      ));
    const res = await admin.stokvel.markMissed({ tenantId: TENANT_ID });
    const missed = res.missed.filter((r: any) => r.circleId === circle.id);
    assert(missed.length === 1 && missed[0].status === "missed", "overdue contribution marked missed");
    const res2 = await admin.stokvel.markMissed({ tenantId: TENANT_ID });
    assert(res2.missed.filter((r: any) => r.circleId === circle.id).length === 0, "scan is idempotent");

    const events = await world.db.select().from(schema.stokvelEvents)
      .where(eq(schema.stokvelEvents.circleId, circle.id));
    assert(events.some((e: any) => e.kind === "contribution_missed"), "audit: contribution_missed logged");

    // B can no longer pay the missed cycle.
    await world.text(silent, `stokvel contribute ${prefix}`);
    const late = bodyText(world.outbound.lastOfType("text", silent));
    assert(late.includes("⚠️") || late.includes("⚠"), `missed member cannot pay late (got: ${late})`);
    contribs = await world.db.select().from(schema.stokvelContributions)
      .where(eq(schema.stokvelContributions.circleId, circle.id));
    assert(contribs.filter((c: any) => c.status === "paid").length === 1, "missed contribution did not flip to paid");
  },
};
