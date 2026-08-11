/**
 * J57 — KYB-gated go-live. A tenant in 'validating + validationPassed' state
 * attempts onboarding.activate WITHOUT an approved KYB → FORBIDDEN with a
 * clear KYB message. After the platform admin approves the tenant's KYB
 * application, activate succeeds and the tenant goes live. Provisioning
 * (onboarding.start) ran with TEMPORAL_ADDRESS set, so the
 * TenantOnboardingWorkflow fired (recorded in temporal_workflow_runs — the
 * Temporal client falls back to a local run record when the server is a
 * mock/unreachable).
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J57",
  name: "KYB-gated go-live",
  feature: "onboarding.activate KYB precondition",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    // Provision a fresh tenant with Temporal "configured" (mock: unreachable
    // address → graceful fallback still records the workflow run).
    process.env.TEMPORAL_ADDRESS = "127.0.0.1:1";
    const started = await admin.onboarding.start({ name: "KYB Gate Store", plan: "starter" });
    const tenantId = started.tenantId;
    assert(tenantId, "tenant provisioned");
    const runs = await world.db
      .select()
      .from(schema.temporalWorkflowRuns)
      .where(and(eq(schema.temporalWorkflowRuns.tenantId, tenantId), eq(schema.temporalWorkflowRuns.workflowType, "TenantOnboardingWorkflow")));
    assert(runs.length === 1, `Temporal TenantOnboardingWorkflow recorded (got ${runs.length})`);
    assert(runs[0].status === "running", "workflow run recorded as running");

    // Drive the state machine to validating + validationPassed (the
    // activation preconditions short of KYB).
    const { setOnboardingStatus } = await import("../../server/services/onboarding");
    await setOnboardingStatus(tenantId, "validating", { validationPassed: true });

    // ── Attempt go-live WITHOUT approved KYB → 403 with a clear message ───
    const tenantUser = await tenantCaller(tenantId, { userId: 91 });
    const err = await expectTrpcError(
      tenantUser.onboarding.activate({ tenantId }),
      "FORBIDDEN",
      "activate without approved KYB",
    );
    assertIncludes(err.message, "KYB verification required", "clear KYB gate message");
    const [tenantRow] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert((tenantRow.settings as any).onboarding.status === "validating", "tenant NOT activated");
    assert(tenantRow.status !== "active", "tenant status not flipped to active");

    // A pending (not approved) KYB application does NOT pass the gate.
    const app = await tenantUser.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
    await tenantUser.kyc.submit({ applicationId: app.id });
    await expectTrpcError(
      tenantUser.onboarding.activate({ tenantId }),
      "FORBIDDEN",
      "activate with merely-pending KYB",
    );

    // ── Admin approves KYB → activate succeeds ────────────────────────────
    const review = await admin.kyc.review({ applicationId: app.id, decision: "approved", notes: "sim: docs verified" });
    assert(review.ok, "admin approved the KYB application");
    const [appRow] = await world.db.select().from(schema.kycApplications).where(eq(schema.kycApplications.id, app.id)).limit(1);
    assert(appRow.status === "approved" && appRow.approvedAt, "KYB approval persisted");

    const activated = await tenantUser.onboarding.activate({ tenantId });
    assert(activated.ok, "activate succeeded after KYB approval");
    const [liveRow] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    assert((liveRow.settings as any).onboarding.status === "live", "onboarding state = live");
    assert(liveRow.status === "active", "tenant status flipped to active");
  },
};
