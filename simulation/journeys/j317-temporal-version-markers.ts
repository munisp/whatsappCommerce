/**
 * === W42 workflows (Coder C / PLT-10) ===
 * J317 — Temporal workflow versioning: WORKFLOW_VERSIONS constants exist for every
 * workflow, the worker build id is pinned to the version tuple (and overridable per
 * deploy), and the workflows are REAL @temporalio/workflow SDK code (proxyActivities +
 * durable timers) — the pseudocode-era versionGate() shim is gone.
 */
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J317",
  name: "temporal workflow version markers",
  feature: "WORKFLOW_VERSIONS + worker buildId + real-SDK workflows",
  async run() {
    const v = await import("../../services/temporal-workflows/versions");

    // Version constants exist for every workflow and are positive integers.
    for (const name of ["tenantOnboarding", "orderFulfillment", "inventorySync", "broadcastCampaign"] as const) {
      const n = v.WORKFLOW_VERSIONS[name];
      assert(Number.isInteger(n) && n >= 1, `${name} version must be a positive integer, got ${n}`);
    }
    // The stub-removal bumps landed on the two money/KYC workflows and were kept through the SDK rewrite.
    assert(v.WORKFLOW_VERSIONS.tenantOnboarding >= 2, "tenantOnboarding version recorded (>= v2 no-auto-approve-kyc)");
    assert(v.WORKFLOW_VERSIONS.orderFulfillment >= 2, "orderFulfillment version recorded (>= v2 no-auto-confirm-payment)");

    // Worker build id is pinned to the version tuple and deterministic; a deploy may override it.
    const tuple = Object.values(v.WORKFLOW_VERSIONS).join(".");
    assertIncludes(v.workerBuildId(), tuple, "build id carries the version tuple");
    assert(v.workerBuildId() === v.workerBuildId(), "build id is deterministic");
    assert(v.workerBuildId("  custom-build ") === "custom-build", "TEMPORAL_WORKER_BUILD_ID override is honored (trimmed)");
    assert(v.workerBuildId("   ") === v.workerBuildId(), "a blank override falls back to the tuple");

    // The worker pins the build id into Worker.create.
    const fs = await import("node:fs");
    const workerSrc = fs.readFileSync("services/temporal-workflows/worker.ts", "utf8");
    assertIncludes(workerSrc, "buildId: WORKER_BUILD_ID", "worker passes buildId to Worker.create");

    // Workflows are real SDK code, not pseudocode.
    const wfSrc = fs.readFileSync("services/temporal-workflows/workflows.ts", "utf8");
    assertIncludes(wfSrc, 'from "@temporalio/workflow"', "workflows import the real SDK");
    assertIncludes(wfSrc, "proxyActivities", "activities are invoked through proxyActivities");
    assert(!/registerActivityHandlers|versionGate/.test(wfSrc), "pseudocode-era shims (registerActivityHandlers/versionGate) are gone");
  },
};
