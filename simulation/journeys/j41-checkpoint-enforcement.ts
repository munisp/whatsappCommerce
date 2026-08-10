/**
 * J41 — Checkpoint enforcement (guarding the guard): driving the copilot
 * service API directly, applying a PENDING proposal must throw, and going
 * live before validation has passed must be refused — with zero settings
 * mutated. The proper approve → validate → go-live sequence then succeeds,
 * proving the guard rejects only premature actions.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { clearGraphObject, registerGraphObject } from "../metaMock";
import { tenantRowById } from "./helpers";

const J41_PHONE_NUMBER_ID = "109000555444333";

export const journey: Journey = {
  id: "J41",
  name: "checkpoint enforcement",
  feature: "apply/goLive without approval refused, no mutation",
  async run(world) {
    const copilot = await import("../../server/services/onboardingCopilot");
    const schema = await import("../../drizzle/schema");

    const { sessionId, greeting } = await copilot.startSession({ channel: "admin" });
    assert(greeting.includes("onboarding assistant"), "greeting returned by startSession");

    // ── Intake → pending proposals ──────────────────────────────────────────
    await copilot.postMessage({
      sessionId,
      text: "I run Checkpoint Traders in Kano, electronics + phones, delivery within Kano, bank transfer",
    });
    let session = await copilot.getSession(sessionId);
    assert(session?.state === "approving", `proposals pending (got ${session?.state})`);
    const waMenuProposal = session.proposals.find((p) => p.kind === "waMenu" && p.status === "pending");
    assert(waMenuProposal, "waMenu proposal pending");

    const tenantCountBefore = (await world.db.select({ id: schema.tenants.id }).from(schema.tenants)).length;

    // ── applyProposal WITHOUT approval → throws, nothing persisted ──────────
    let applyErr: Error | null = null;
    try {
      await copilot.executeCopilotTool("applyProposal", { proposalId: waMenuProposal.id }, session);
    } catch (e: any) {
      applyErr = e;
    }
    assert(applyErr, "applyProposal on a pending proposal throws");
    assert(
      /has not been approved/.test(applyErr!.message),
      `checkpoint error names the precondition (got: ${applyErr!.message})`,
    );

    // ── goLive BEFORE anything is approved → refused ────────────────────────
    const goLiveRefusal = await copilot.executeCopilotTool("goLive", {}, session);
    assert(goLiveRefusal.ok === false, "goLive refused before any approval");

    // ── No settings mutated by the refused calls ────────────────────────────
    const tenantCountAfter = (await world.db.select({ id: schema.tenants.id }).from(schema.tenants)).length;
    assert(tenantCountAfter === tenantCountBefore, "refused apply/goLive created no tenant");
    session = await copilot.getSession(sessionId);
    assert(!session?.tenantId, "session still has no tenant after refused mutations");
    assert(
      session?.proposals.every((p) => p.status === "pending"),
      "refused calls left every proposal pending",
    );

    // ── Proper approvals succeed (checkpoint passes after human decision) ───
    for (const p of session!.proposals.filter((x) => x.status === "pending")) {
      await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    }
    session = await copilot.getSession(sessionId);
    assert(session?.tenantId, "tenant provisioned after proper approvals");
    const tenant = await tenantRowById(world, session!.tenantId!);
    assert(
      (tenant?.settings as any)?.waMenu?.greeting?.includes("Checkpoint Traders"),
      "approved waMenu applied to tenant settings",
    );
    assert(session?.state === "configuring", `validation failed w/o creds → repair (got ${session?.state})`);

    // ── goLive with a tenant but failed validation → throws, no mutation ────
    let goLiveErr: Error | null = null;
    try {
      await copilot.executeCopilotTool("goLive", {}, session!);
    } catch (e: any) {
      goLiveErr = e;
    }
    assert(goLiveErr, "goLive throws while validation has not passed");
    assert(
      /validation has not passed/.test(goLiveErr!.message),
      `go-live precondition named (got: ${goLiveErr!.message})`,
    );
    const tenantAfterRefusal = await tenantRowById(world, session!.tenantId!);
    assert(tenantAfterRefusal?.status === "trial", `tenant NOT activated by refused go-live (got ${tenantAfterRefusal?.status})`);
    assert(
      (tenantAfterRefusal?.settings as any)?.onboarding?.status !== "live",
      "onboarding state untouched by refused go-live",
    );

    // ── Proper path: credentials → validation → approve go-live → live ──────
    registerGraphObject(J41_PHONE_NUMBER_ID);
    await copilot.postMessage({
      sessionId,
      text: `phone number id is ${J41_PHONE_NUMBER_ID} token is EAAj41tokenabc123456`,
    });
    session = await copilot.getSession(sessionId);
    assert(session?.state === "validating", `validation passed (got ${session?.state})`);
    const goLive = session!.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
    assert(goLive, "goLive proposal emitted");
    const decision = await copilot.decideProposal({ sessionId, proposalId: goLive!.id, approve: true });
    assert(decision.ok, "go-live approval accepted");
    session = await copilot.getSession(sessionId);
    assert(session?.state === "live", `session live after proper approval (got ${session?.state})`);
    const liveTenant = await tenantRowById(world, session!.tenantId!);
    assert(liveTenant?.status === "active", "tenant activated by the approved go-live");
    clearGraphObject(J41_PHONE_NUMBER_ID);
  },
};
