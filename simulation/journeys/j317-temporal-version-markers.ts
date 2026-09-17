/**
 * === W42 workflows (Coder C / PLT-10) ===
 * J317 — Temporal workflow versioning markers exist and are deterministic:
 * WORKFLOW_VERSIONS constants, patched()-compatible versionGate() at the W42
 * change points, and a worker build id pinned to the version tuple.
 */
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J317",
  name: "temporal workflow version markers",
  feature: "WORKFLOW_VERSIONS + versionGate change markers + worker buildId",
  async run() {
    const wf = await import("../../services/temporal-workflows/workflows");

    // Version constants exist for every workflow and are positive integers.
    for (const name of ["tenantOnboarding", "orderFulfillment", "inventorySync", "broadcastCampaign"] as const) {
      const v = wf.WORKFLOW_VERSIONS[name];
      assert(Number.isInteger(v) && v >= 1, `${name} version must be a positive integer, got ${v}`);
    }
    // The W42 stub-removal bumps landed on the two money/KYC workflows.
    assert(wf.WORKFLOW_VERSIONS.tenantOnboarding >= 2, "tenantOnboarding v2 (no-auto-approve-kyc) recorded");
    assert(wf.WORKFLOW_VERSIONS.orderFulfillment >= 2, "orderFulfillment v2 (no-auto-confirm-payment) recorded");

    // versionGate is deterministic: same inputs → same output, every call.
    assert(wf.versionGate("tenantOnboarding", "no-auto-approve-kyc", 2) === true, "gate open at current version");
    assert(wf.versionGate("tenantOnboarding", "no-auto-approve-kyc", 2) === true, "gate deterministic on repeat");
    assert(
      wf.versionGate("inventorySync", "future-change", wf.WORKFLOW_VERSIONS.inventorySync + 1) === false,
      "gate closed for a version above current (replay of pre-change history)"
    );

    // Worker build id is pinned to the version tuple (worker versioning).
    const tuple = Object.values(wf.WORKFLOW_VERSIONS).join(".");
    assertIncludes(wf.WORKER_BUILD_ID, tuple, "build id carries version tuple");

    // The worker pins the build id into Worker.create (worker versioning).
    const fs = await import("node:fs");
    const workerSrc = fs.readFileSync("services/temporal-workflows/worker.ts", "utf8");
    assertIncludes(workerSrc, "buildId: WORKER_BUILD_ID", "worker passes buildId to Worker.create");
    assertIncludes(workerSrc, "registerActivityHandlers(activities)", "worker wires real handlers at boot");
  },
};
