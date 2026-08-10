/**
 * J42 — Validation-repair loop: two runs through the copilot service API.
 *
 * Phase A (repair succeeds): seeded tenant creds make the WABA check fail
 * (the harness Graph mock 404s the unregistered WABA) → the session drops
 * back to 'configuring' with the TARGETED question ("token can't read the
 * WABA…") → corrected token supplied → checks pass → goLive proposal.
 *
 * Phase B (repair exhausts): three failed validation rounds flip the session
 * to 'failed' with the reasons preserved, and the tenant's onboarding state
 * records the failure.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { clearGraphObject, registerGraphObject } from "../metaMock";
import { tenantRowById } from "./helpers";

const J42_PHONE_NUMBER_ID = "pn_j42_bad";
const J42_WABA_ID = "waba_j42";

async function driveToConfiguring(world: World, businessText: string) {
  const copilot = await import("../../server/services/onboardingCopilot");
  const { sessionId } = await copilot.startSession({ channel: "admin" });
  await copilot.postMessage({ sessionId, text: businessText });
  let session = await copilot.getSession(sessionId);
  assert(session?.state === "approving", `proposals pending (got ${session?.state})`);
  for (const p of session!.proposals.filter((x) => x.status === "pending")) {
    await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
  }
  session = await copilot.getSession(sessionId);
  assert(session?.tenantId, "tenant provisioned during configuration");
  return { copilot, sessionId, session: session! };
}

export const journey: Journey = {
  id: "J42",
  name: "validation-repair loop",
  feature: "failed checks → targeted repair → pass; cap → failed",
  async run(world) {
    // ══ Phase A: WABA check fails, repair question, corrected token wins ════
    const a = await driveToConfiguring(
      world,
      "I run Repair Fabrics in Ibadan, ankara + lace, delivery within Ibadan, bank transfer",
    );
    assert(a.session.state === "configuring", `validation failed w/o creds (got ${a.session.state})`);
    assert(a.session.intake.repairRounds === 1, `repair round 1 recorded (got ${a.session.intake.repairRounds})`);
    const firstQuestion = a.session.transcript[a.session.transcript.length - 1]?.text ?? "";
    assert(
      firstQuestion.includes("re-paste your WhatsApp access token"),
      `first repair question targets missing credentials (got: ${firstQuestion.slice(0, 120)})`,
    );

    // Seed creds whose PHONE NUMBER reads fine but whose WABA is unreadable.
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { updateTenantSettings } = await import("../../server/services/onboarding");
    await world.db
      .update(schema.tenants)
      .set({ whatsappPhoneNumberId: J42_PHONE_NUMBER_ID, whatsappBusinessAccountId: J42_WABA_ID, updatedAt: new Date() })
      .where(eq(schema.tenants.id, a.session.tenantId!));
    await updateTenantSettings(a.session.tenantId!, (s) => {
      s.whatsapp = { ...(s.whatsapp ?? {}), accessToken: "EAAj42seedtoken00000001" };
    });
    registerGraphObject(J42_PHONE_NUMBER_ID); // phone number readable…
    // …but J42_WABA_ID deliberately unregistered → Graph 404 on the WABA check.

    const round2 = await a.copilot.postMessage({
      sessionId: a.sessionId,
      text: "token is EAAj42stillbadtoken0001",
    });
    assert(round2.state === "configuring", `still configuring after failed re-run (got ${round2.state})`);
    const wabaQuestion = round2.replies.map((r) => r.text).join("\n");
    assert(
      wabaQuestion.includes("can't read the WhatsApp Business Account (WABA)"),
      `targeted WABA repair question sent (got: ${wabaQuestion.slice(0, 200)})`,
    );
    let session = await a.copilot.getSession(a.sessionId);
    assert(session?.intake.repairRounds === 2, `repair round 2 recorded (got ${session?.intake.repairRounds})`);

    // Corrected token (the WABA now reads) → checks pass → goLive proposal.
    registerGraphObject(J42_WABA_ID);
    const fixed = await a.copilot.postMessage({
      sessionId: a.sessionId,
      text: "token is EAAj42correctedtoken001",
    });
    assert(fixed.state === "validating", `checks pass after correction (got ${fixed.state})`);
    assert(
      fixed.replies.some((r) => r.text.includes("validation checks passed")),
      "go-live prompt emitted after checks pass",
    );
    session = await a.copilot.getSession(a.sessionId);
    assert(
      session?.proposals.some((p) => p.kind === "goLive" && p.status === "pending"),
      "goLive proposal pending after repair succeeds",
    );

    // ══ Phase B: three failed rounds → session 'failed' with reasons ════════
    const b = await driveToConfiguring(
      world,
      "I run Failing Ventures in Jos, furniture + home decor, pickup only, cash",
    );
    assert(b.session.state === "configuring" && b.session.intake.repairRounds === 1, "round 1 failed");

    const roundB2 = await b.copilot.postMessage({ sessionId: b.sessionId, text: "I don't have the token yet" });
    assert(roundB2.state === "configuring", `round 2 keeps the session configuring (got ${roundB2.state})`);

    const roundB3 = await b.copilot.postMessage({ sessionId: b.sessionId, text: "still broken on my side" });
    assert(roundB3.state === "failed", `repair cap reached → failed (got ${roundB3.state})`);
    assert(
      roundB3.replies.some((r) => r.text.includes("tried to validate your setup a few times")),
      "failure message explains the exhausted retries",
    );
    const failedSession = await b.copilot.getSession(b.sessionId);
    assert(failedSession?.state === "failed", "session persisted as failed");
    assert(
      typeof failedSession?.error === "string" && failedSession.error.includes("whatsapp:"),
      `failure reasons preserved on the session (got: ${failedSession?.error})`,
    );
    const failedTenant = await tenantRowById(world, failedSession!.tenantId!);
    assert(
      (failedTenant?.settings as any)?.onboarding?.status === "failed",
      "tenant onboarding state records the failure",
    );
    assert(
      ((failedTenant?.settings as any)?.onboarding?.reasons ?? []).some((r: string) => r.includes("whatsapp:")),
      "tenant onboarding reasons include the failing check",
    );

    clearGraphObject(J42_PHONE_NUMBER_ID);
    clearGraphObject(J42_WABA_ID);
  },
};
