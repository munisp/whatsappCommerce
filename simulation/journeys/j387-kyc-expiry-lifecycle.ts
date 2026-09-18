// === W46 kyc (Coder A) ===
/**
 * J387 — TEN-6: KYC expiry lifecycle.
 *  1. Approval stamps expiresAt per risk tier (PEP → high → 180d).
 *  2. The kyc-expiry-sweep cron flips past-due approved applications to
 *     'expired' (guarded UPDATE) + writes an audit row.
 *  3. Re-verification flow: getOrCreateApplication treats 'expired' as
 *     re-openable and issues a fresh application.
 */
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J387",
  name: "KYC expiry: tiered expiresAt + cron sweep + re-verification",
  feature: "TEN-6 kycExpiresAt at approval + runKycExpirySweep + reopen",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const prevFlag = process.env.KYB_SCREENING_DISABLED;
    process.env.KYB_SCREENING_DISABLED = "true"; // test env: screening skippable
    try {
      const tenantId = `j387-${randomUUID().slice(0, 8)}`;
      await world.db.insert(schema.tenants).values({
        id: tenantId, name: "J387 Expiry Store", slug: tenantId, status: "active",
      }).onConflictDoNothing();
      const [u] = await world.db.insert(schema.users).values({
        openId: `j387-${randomUUID().slice(0, 8)}`, email: "j387@sim.local", name: "J387 Owner",
        loginMethod: "keycloak", role: "user", tenantId, lastSignedIn: new Date(),
      }).returning();
      const { appRouter } = await import("../../server/routers");
      const caller = appRouter.createCaller({
        user: { id: u.id, openId: u.openId, email: u.email, name: u.name, loginMethod: "keycloak", role: "user", tenantId, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
        req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} },
      } as any);

      // Application with PEP declared → high tier → 180-day validity.
      const app = await caller.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
      await caller.kyc.updateApplication({ applicationId: app.id, businessName: "J387 Ltd", pepDeclared: true });
      await caller.kyc.submit({ applicationId: app.id });
      const admin = await adminCaller();
      const before = Date.now();
      await admin.kyc.review({ applicationId: app.id, decision: "approved" });
      const [approved] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, app.id));
      assert(approved.status === "approved", "approved");
      assert(approved.expiresAt, "TEN-6: expiresAt stamped at approval");
      const days = (approved.expiresAt!.getTime() - before) / 86_400_000;
      assert(days > 179 && days < 181, `high-risk (PEP) validity ≈180d (got ${days.toFixed(2)})`);

      // Low-risk tier sanity via the pure helpers.
      const { computeRiskTier, KYC_VALIDITY_DAYS } = await import("../../server/services/kycExpiry");
      assert(computeRiskTier({ pepDeclared: true }) === "high", "PEP → high");
      assert(computeRiskTier({ riskScore: "85" }) === "high", "score 85 → high");
      assert(computeRiskTier({ riskScore: "50" }) === "standard", "score 50 → standard");
      assert(computeRiskTier({ riskScore: "10" }) === "low", "score 10 → low");
      assert(computeRiskTier({}) === "standard", "unknown → standard");
      assert(KYC_VALIDITY_DAYS.low === 730 && KYC_VALIDITY_DAYS.standard === 365, "tier validity map");

      // Backdate expiry → cron sweep flips to expired + audit row.
      await world.db.update(schema.kycApplications)
        .set({ expiresAt: new Date(Date.now() - 3600_000) })
        .where(eq(schema.kycApplications.id, app.id));
      const res = await world.runCron("/api/scheduled/kyc-expiry-sweep");
      assert(res.status === 200 && res.json?.ok === true, `expiry sweep cron 200 (got ${res.status} ${JSON.stringify(res.json)})`);
      assert(res.json.run.expired >= 1, "sweep expired at least one application");
      const [expired] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, app.id));
      assert(expired.status === "expired", "application flipped to expired by sweep");
      const audits = await world.db.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.entityId, app.id), eq(schema.auditLogs.action, "kyc.expired")));
      assert(audits.length === 1, "expiry audited");

      // Re-verification: expired applications re-open as a fresh application.
      const fresh = await caller.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
      assert(fresh.id !== app.id && fresh.status === "not_started", "re-verification issues a fresh application");
    } finally {
      if (prevFlag === undefined) delete process.env.KYB_SCREENING_DISABLED;
      else process.env.KYB_SCREENING_DISABLED = prevFlag;
    }
  },
};
// === END W46 kyc ===
