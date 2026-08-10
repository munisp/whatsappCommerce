/**
 * J43 — Idempotency + resume + restart on the platform onboarding number:
 *
 * 1. Meta redelivers the identical webhook (same wamid, same text). The
 *    onboarding branch skips the wamid dedupe ledger by design, so the
 *    copilot's own idempotent postMessage (exact-repeat → no-op) is what
 *    guards correctness: no duplicate replies, no transcript growth, no
 *    state change.
 * 2. The prospect goes silent mid-flow and texts again later — the session
 *    is resumed at the same state and the command applies.
 * 3. "restart" abandons the active session and greets afresh.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { onboardingSessionById, onboardingSessionByPhone } from "./helpers";

export const journey: Journey = {
  id: "J43",
  name: "idempotency resume restart",
  feature: "redelivery no-op, mid-flow resume, restart supersedes",
  async run(world) {
    const phone = world.newPhone("idem");

    // ── Start + intake (with explicit wamids so redelivery is identical) ────
    await world.onboardingText(phone, "hi there", { id: "wamid.j43.greeting" });
    const greeting = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(greeting, "onboarding assistant", "greeting delivered");

    const intakeText = "I run Resume Styles in Enugu, fashion clothing, delivery within Enugu, bank transfer";
    await world.onboardingText(phone, intakeText, { id: "wamid.j43.intake" });
    const s1 = await onboardingSessionByPhone(phone);
    assert(s1?.state === "approving", `proposals pending (got ${s1?.state})`);
    const proposalCount = s1!.proposals.length;
    const transcriptCount = s1!.transcript.length;
    const outboundCount = world.outbound.toPhone(phone).length;

    // ── 1. Identical redelivery (same wamid + text) → no-op ────────────────
    await world.onboardingText(phone, intakeText, { id: "wamid.j43.intake" });
    const s2 = await onboardingSessionByPhone(phone);
    assert(s2?.id === s1!.id, "redelivery did not spawn a new session");
    assert(
      world.outbound.toPhone(phone).length === outboundCount,
      "redelivery produced no duplicate replies",
    );
    assert(s2?.state === "approving", `redelivery caused no state change (got ${s2?.state})`);
    assert(
      s2?.transcript.length === transcriptCount,
      `redelivery did not grow the transcript (${s2?.transcript.length} vs ${transcriptCount})`,
    );
    assert(s2?.proposals.length === proposalCount, "redelivery created no duplicate proposals");

    // ── 2. Silence → resume at the same state ──────────────────────────────
    await world.onboardingText(phone, "approve waMenu");
    const approvedNote = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(approvedNote, "Approved: waMenu", "resume processes the approval command");
    const s3 = await onboardingSessionByPhone(phone);
    assert(s3?.id === s1!.id, "resume stays on the same session");
    assert(s3?.state === "approving", `resumed session keeps the approving state (got ${s3?.state})`);
    assert(
      s3?.proposals.find((p) => p.kind === "waMenu")?.status === "approved",
      "waMenu approval applied on resume",
    );

    // ── 3. "restart" → prior session abandoned, fresh greeting ─────────────
    await world.onboardingText(phone, "restart");
    const abandoned = await onboardingSessionById(s1!.id);
    assert(abandoned?.state === "abandoned", `prior session abandoned (got ${abandoned?.state})`);
    const fresh = await onboardingSessionByPhone(phone);
    assert(fresh && fresh.id !== s1!.id, "fresh session started after restart");
    assert(fresh!.state === "intake", `fresh session in intake (got ${fresh!.state})`);
    const freshGreeting = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(freshGreeting, "onboarding assistant", "fresh greeting delivered after restart");
    assert(fresh!.proposals.length === 0, "fresh session carries no stale proposals");
  },
};
