// === W47 merchant ===
/**
 * J435 — ONB-M-13 (appeal policy consistency + 4-eyes on stable user ids)
 * + ONB-M-14 (initial payout capture during onboarding; getStatus exposes
 * payoutConfigured).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

async function adminCallerAs(id: number, name: string) {
  const { appRouter } = await import("../../server/routers");
  return appRouter.createCaller({
    user: {
      id, openId: `sim-admin-${id}`, email: `admin${id}@sim.local`, name,
      loginMethod: "keycloak", role: "admin",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "http", headers: {} },
    res: { clearCookie: () => {} },
  } as any);
}

export const journey: Journey = {
  id: "J435",
  name: "appeal 4-eyes on user ids + payout capture (ONB-M-13/M-14)",
  feature: "W47 merchant: appeal XOR new application; onboarding payout step",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const started = await admin.onboarding.start({ name: "J435 Appeal Store" });
    const tenantId = started.tenantId;
    const merchant = await tenantCaller(tenantId, { userId: 435, memberships: [tenantId] });

    // ── M-13: rejected application must be APPEALED, not restarted ───────
    const app = await merchant.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
    await merchant.kyc.submit({ applicationId: app.id });
    // Two admins with the SAME display name — the 4-eyes rule must key on ids.
    const adminA = await adminCallerAs(4351, "Admin");
    const adminB = await adminCallerAs(4352, "Admin");
    await adminA.kyc.review({ applicationId: app.id, decision: "rejected", rejectionReason: "sim: bad docs" });
    await expectTrpcError(
      merchant.kyc.getOrCreateApplication({ tenantId, type: "kyb" }),
      "PRECONDITION_FAILED",
      "fresh application after rejection blocked — appeal path only",
    );
    await merchant.kyc.appeal({ applicationId: app.id, reason: "sim: documents were misread, please re-check" });
    // The ORIGINAL reviewer cannot adjudicate their own appeal — even though
    // the other admin shares the same display name, ids decide.
    await expectTrpcError(
      adminA.kyc.review({ applicationId: app.id, decision: "approved", notes: "self-appeal attempt" }),
      "FORBIDDEN",
      "same-id reviewer blocked on appeal (4-eyes)",
    );
    const re = await adminB.kyc.review({ applicationId: app.id, decision: "approved", notes: "sim: second pair of eyes" });
    assert(re.ok, "different admin id may adjudicate the appeal");
    const [appRow] = await world.db.select().from(schema.kycApplications)
      .where(eq(schema.kycApplications.id, app.id)).limit(1);
    assert(appRow.status === "approved", "appeal approved by second admin");
    assert((appRow as any).reviewedByUserId === 4352, "stable reviewer id stamped");

    // ── M-14: initial payout capture + readiness flag ────────────────────
    let status = await merchant.onboarding.getStatus({ tenantId });
    assert(status.payoutConfigured === false, "payout not configured initially");
    const saved = await merchant.onboarding.updateStep({
      tenantId,
      step: "payout",
      data: { bankAccountName: "J435 Merchant", bankAccountNumber: "0123456789", bankCode: "058" },
    });
    assert(saved.ok && saved.completedSteps.includes("payout"), "payout step completed");
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, tenantId)).limit(1);
    assert(wallet?.bankAccountNumber === "0123456789" && wallet?.bankCode === "058", "wallet payout details persisted");
    status = await merchant.onboarding.getStatus({ tenantId });
    assert(status.payoutConfigured === true, "getStatus reports payoutConfigured");
    // Second capture is refused — changes stay behind the step-up OTP path.
    await expectTrpcError(
      merchant.onboarding.updateStep({
        tenantId,
        step: "payout",
        data: { bankAccountName: "Attacker", bankAccountNumber: "9999999999", bankCode: "999" },
      }),
      "CONFLICT",
      "payout details overwrite refused",
    );
    const [wallet2] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, tenantId)).limit(1);
    assert(wallet2?.bankAccountNumber === "0123456789", "payout details unchanged");
  },
};
