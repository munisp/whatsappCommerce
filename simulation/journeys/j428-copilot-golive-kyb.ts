// === W47 merchant ===
/**
 * J428 — ONB-M-2 (P0 regression): the chat-copilot goLive must enforce the
 * same requireApprovedKyb gate as web activate. Drives the copilot tool
 * directly: validation passed but no KYB → refusal naming KYB, no tenant
 * flip; approved KYB → live. Also pins the ONB-M-4 typed seam comment.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, tenantRowById } from "./helpers";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J428",
  name: "copilot goLive enforces KYB gate (ONB-M-2)",
  feature: "W47 merchant: chat-copilot go-live parity with web activate",
  async run(world) {
    const copilot = await import("../../server/services/onboardingCopilot");
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    await copilot.postMessage({
      sessionId,
      text: "I run Gate Parity Stores in Abuja, groceries, delivery within Abuja, bank transfer",
    });
    let session = await copilot.getSession(sessionId);
    assert(session?.state === "approving", "proposals pending");
    for (const p of session!.proposals.filter((x) => x.status === "pending")) {
      await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    }
    session = await copilot.getSession(sessionId);
    assert(session?.tenantId, "tenant provisioned");
    const tenantId = session!.tenantId!;

    // Validation passed (drive the state machine directly — the live Graph
    // check is covered by J41/J42) but NO KYB application exists.
    const { setOnboardingStatus } = await import("../../server/services/onboarding");
    await setOnboardingStatus(tenantId, "validating", { validationPassed: true });

    let refusal: Error | null = null;
    try {
      await copilot.executeCopilotTool("goLive", {}, session!);
    } catch (e: any) {
      refusal = e;
    }
    assert(refusal, "copilot goLive refuses without approved KYB");
    assert(/KYB/.test(refusal!.message), `refusal names KYB (got: ${refusal!.message})`);
    let tenant = await tenantRowById(world, tenantId);
    assert(tenant?.status !== "active", "tenant NOT activated by refused copilot goLive");
    assert((tenant?.settings as any)?.onboarding?.status !== "live", "onboarding state untouched");

    // Approved KYB → the SAME tool now goes live (parity with activate).
    await approveKyb(world, tenantId);
    const ok = await copilot.executeCopilotTool("goLive", {}, (await copilot.getSession(sessionId))!);
    assert(ok.ok === true, `copilot goLive succeeds after KYB approval (${JSON.stringify(ok.result)?.slice(0, 160)})`);
    tenant = await tenantRowById(world, tenantId);
    assert(tenant?.status === "active", "tenant active after gated copilot go-live");
    assert((tenant?.settings as any)?.onboarding?.status === "live", "onboarding state live");

    // ONB-M-4 seam: typed bootstrapTenantOwner hook must be present in the
    // copilot goLive path (implementation owned by Coder D).
    const src = await readFile(`${repoRoot}/server/services/onboardingCopilot/tools.ts`, "utf8");
    assertIncludes(src, "bootstrapTenantOwner", "goLive carries the ONB-M-4 owner-bootstrap seam");
    assertIncludes(src, "goLiveTenant", "copilot goLive routes through the shared gate");
  },
};
