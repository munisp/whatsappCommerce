/**
 * === W42 workflows (Coder C / PLT-10) ===
 * J321 — The W36 auto-approve activity stubs are GONE: with no real handlers
 * registered, the money/KYC activities honestly throw `activity_not_wired`
 * instead of returning fabricated success ("approved" / true). A registered
 * handler IS used, and workflow execution propagates handler failure.
 */
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

async function expectNotWired(fn: () => Promise<unknown>, label: string): Promise<void> {
  let err: Error | null = null;
  try {
    await fn();
  } catch (e: any) {
    err = e;
  }
  assert(err, `${label}: must throw without wired handlers (stub would have fabricated success)`);
  assertIncludes(err!.message, "activity_not_wired", `${label} honest-fail reason`);
}

export const journey: Journey = {
  id: "J321",
  name: "temporal auto-approve stubs removed",
  feature: "unwired activities honestly fail; never return fixed approved/true",
  async run() {
    const wf = await import("../../services/temporal-workflows/workflows");

    // Sim never boots the temporal worker → no handlers wired here.
    assert(wf.hasActivityHandlers() === false, "no handlers wired in sim world");

    // Every stub-era fabrication is now an honest failure.
    await expectNotWired(() => wf.activities.waitForKycApproval("kyc-x"), "waitForKycApproval");
    await expectNotWired(() => wf.activities.confirmPayment("order-x"), "confirmPayment");
    await expectNotWired(() => wf.activities.reserveInventory([]), "reserveInventory");
    await expectNotWired(() => wf.activities.validateWhatsAppCredentials("t-x"), "validateWhatsAppCredentials");
    await expectNotWired(() => wf.activities.buildAudience("c-x"), "buildAudience");

    // Full workflow: KYC step must propagate the honest failure (no auto-approve).
    let wfErr: Error | null = null;
    try {
      await wf.TenantOnboardingWorkflow({
        tenantId: "t-j321",
        applicantEmail: "j321@sim.local",
        billingModel: "subscription",
        kycApplicationId: "kyc-j321",
      });
    } catch (e: any) {
      wfErr = e;
    }
    assert(wfErr, "TenantOnboardingWorkflow fails without wired KYC handler");
    assertIncludes(wfErr!.message, "activity_not_wired", "workflow propagates honest failure");

    // A registered REAL handler is used verbatim (incl. non-approved verdicts).
    wf.registerActivityHandlers({
      waitForKycApproval: async () => "rejected",
    } as any);
    assert(wf.hasActivityHandlers() === true, "handler registered");
    const decision = await wf.activities.waitForKycApproval("kyc-x");
    assert(decision === "rejected", `wired handler verdict honored (got ${decision}) — no forced "approved"`);
  },
};
