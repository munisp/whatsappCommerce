// === W47 merchant ===
/**
 * J427 — ONB-M-1 (P0 regression): the legacy onboarding.complete endpoint
 * must enforce the SAME gate as web activate — validation passed + approved
 * KYB (goLiveTenant). Before the fix it flipped tenants.status to 'active'
 * with neither check.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, approveKyb, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J427",
  name: "legacy onboarding.complete is KYB+validation gated (ONB-M-1)",
  feature: "W47 merchant: legacy go-live bypass closed",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const started = await admin.onboarding.start({ name: "J427 Legacy Gate Store" });
    const tenantId = started.tenantId;
    const caller = await tenantCaller(tenantId, { userId: 427 });

    // 1) No validation → PRECONDITION_FAILED (not a silent flip to active).
    await expectTrpcError(
      caller.onboarding.complete({ tenantId }),
      "PRECONDITION_FAILED",
      "complete without validation",
    );
    let [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert(row.status !== "active", "tenant NOT flipped active without validation");

    // 2) Validation passed but NO approved KYB → FORBIDDEN (same as activate).
    const { setOnboardingStatus, getOnboardingState } = await import("../../server/services/onboarding");
    await setOnboardingStatus(tenantId, "validating", { validationPassed: true });
    const err = await expectTrpcError(
      caller.onboarding.complete({ tenantId }),
      "FORBIDDEN",
      "complete without approved KYB",
    );
    assert(String(err.message).includes("KYB"), `KYB named in refusal (got: ${err.message})`);
    [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert(row.status !== "active", "tenant NOT activated without KYB");
    assert(getOnboardingState(row.settings).status !== "live", "onboarding state not live");

    // 3) Approved KYB → complete succeeds through the shared gate.
    await approveKyb(world, tenantId);
    const done = await caller.onboarding.complete({ tenantId });
    assert(done.ok, "complete succeeds once gated preconditions hold");
    [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert(row.status === "active", "tenant active after gated complete");
    assert(getOnboardingState(row.settings).status === "live", "onboarding state live");

    // 4) The gate wrote an audit row for the security-relevant transition.
    const audit = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, tenantId));
    assert(audit.some((a: any) => a.action === "onboarding.go_live" && a.summary?.includes("legacy-complete")),
      "go-live audit row names the legacy-complete source");
  },
};
