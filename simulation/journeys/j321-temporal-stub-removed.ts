/**
 * === W42 workflows (Coder C / PLT-10) ===
 * J321 — The W36 auto-approve activity stubs are GONE. Activities with no real backing
 * endpoint honestly throw a NON-retryable `activity_not_implemented` instead of returning
 * fabricated success ("approved" / true) and never touch the platform; an activity that IS
 * backed returns the platform's answer verbatim.
 */
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

async function expectNotImplemented(fn: () => Promise<unknown>, label: string): Promise<void> {
  let err: any = null;
  try {
    await fn();
  } catch (e: any) {
    err = e;
  }
  assert(err, `${label}: must throw without a backing endpoint (a stub would have fabricated success)`);
  assertIncludes(err.message, "activity_not_implemented", `${label} honest-fail reason`);
  assert(err.nonRetryable === true, `${label}: must be non-retryable (retrying cannot make it real)`);
}

export const journey: Journey = {
  id: "J321",
  name: "temporal auto-approve stubs removed",
  feature: "unbacked activities honestly fail; never return fixed approved/true",
  async run() {
    const { createActivities } = await import("../../services/temporal-workflows/activities");

    // An apiCall that fails the journey if any unbacked activity tries to use it.
    let apiCalls = 0;
    const a = createActivities({
      apiCall: (async () => {
        apiCalls++;
        return {};
      }) as any,
    });

    // Every stub-era fabrication is now an honest failure.
    await expectNotImplemented(() => a.getKycDecision("kyc-x"), "getKycDecision");
    await expectNotImplemented(() => a.submitKycForReview("kyc-x"), "submitKycForReview");
    await expectNotImplemented(() => a.confirmPayment("order-x"), "confirmPayment");
    await expectNotImplemented(() => a.validateWhatsAppCredentials("t-x"), "validateWhatsAppCredentials");
    await expectNotImplemented(() => a.activateTenant("t-x"), "activateTenant");
    await expectNotImplemented(() => a.buildAudience("c-x"), "buildAudience");
    await expectNotImplemented(() => a.sendBroadcastBatch("c-x", ["+2348000000000"], "tpl"), "sendBroadcastBatch");
    assert(apiCalls === 0, `unbacked activities must not call the platform (made ${apiCalls} calls)`);

    // A BACKED activity uses the platform's verdict verbatim.
    const backed = createActivities({
      apiCall: (async (proc: string) =>
        proc === "temporalInternal.syncTenantInventory" ? { tenantId: "t-j321", recordsSynced: 3 } : { tenantIds: ["t-j321"] }) as any,
    });
    const res = await backed.syncTenantInventory("t-j321");
    assert(res.recordsSynced === 3, `backed activity returns the platform's result (got ${res.recordsSynced})`);
    const tenants = await backed.listInventorySyncTenants();
    assert(tenants.length === 1 && tenants[0] === "t-j321", "listInventorySyncTenants returns the platform's tenants");
  },
};
