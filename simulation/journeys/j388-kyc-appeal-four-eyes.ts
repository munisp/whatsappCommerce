// === W46 kyc (Coder A) ===
/**
 * J388 — TEN-7: KYC rejection appeal path.
 *  1. A rejected application can be appealed exactly once (guarded flip).
 *  2. The appeal re-review must be by a DIFFERENT admin (4-eyes) — the
 *     original reviewer is refused.
 *  3. Both the appeal and the appeal adjudication are audited.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J388",
  name: "KYC appeal: appealed status + 4-eyes re-review + audits",
  feature: "TEN-7 kyc.appeal + different-reviewer enforcement",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const prevFlag = process.env.KYB_SCREENING_DISABLED;
    process.env.KYB_SCREENING_DISABLED = "true";
    try {
      const tenantId = `j388-${randomUUID().slice(0, 8)}`;
      await world.db.insert(schema.tenants).values({
        id: tenantId, name: "J388 Appeal Store", slug: tenantId, status: "active",
      }).onConflictDoNothing();
      const [u] = await world.db.insert(schema.users).values({
        openId: `j388-${randomUUID().slice(0, 8)}`, email: "j388@sim.local", name: "J388 Merchant",
        loginMethod: "keycloak", role: "user", tenantId, lastSignedIn: new Date(),
      }).returning();
      const { appRouter } = await import("../../server/routers");
      const merchant = appRouter.createCaller({
        user: { id: u.id, openId: u.openId, email: u.email, name: u.name, loginMethod: "keycloak", role: "user", tenantId, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
        req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} },
      } as any);
      const admin = await adminCaller(); // name "Sim Admin" — original reviewer

      const app = await merchant.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
      await merchant.kyc.submit({ applicationId: app.id });

      // Appeal before rejection → refused.
      let premature = false;
      try { await merchant.kyc.appeal({ applicationId: app.id, reason: "premature appeal attempt" }); }
      catch { premature = true; }
      assert(premature, "only a rejected application can be appealed");

      // Admin rejects (first decision — audited by kyc.review).
      await admin.kyc.review({ applicationId: app.id, decision: "rejected", rejectionReason: "Blurry documents" });
      const [rej] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, app.id));
      assert(rej.status === "rejected" && rej.reviewedBy === "Sim Admin", "rejected by original reviewer");

      // Merchant appeals → status appealed + kyc.appeal audit row.
      const appealed = await merchant.kyc.appeal({ applicationId: app.id, reason: "Documents were re-scanned in high resolution" });
      assert(appealed.status === "appealed", "appeal flips status to appealed");
      const [ap] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, app.id));
      assert(ap.status === "appealed" && ap.appealedAt && ap.appealReason?.includes("re-scanned"), "appeal fields persisted");

      // Exactly once: a second appeal is refused (guarded flip).
      let twice = false;
      try { await merchant.kyc.appeal({ applicationId: app.id, reason: "duplicate appeal attempt" }); }
      catch { twice = true; }
      assert(twice, "appeal is single-shot");

      // 4-eyes: the ORIGINAL reviewer may not adjudicate the appeal.
      let sameReviewer = false;
      try { await admin.kyc.review({ applicationId: app.id, decision: "approved" }); }
      catch (e: any) { sameReviewer = /different admin|4-eyes/i.test(e?.message ?? ""); }
      assert(sameReviewer, "original reviewer refused on appealed application");

      // A DIFFERENT admin adjudicates → approved; appealReviewedBy journaled.
      const secondAdmin = appRouter.createCaller({
        user: { id: 901, openId: "sim-admin-2", email: "appeals@sim.local", name: "Appeals Admin", loginMethod: "keycloak", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
        req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} },
      } as any);
      await secondAdmin.kyc.review({ applicationId: app.id, decision: "approved" });
      const [done] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, app.id));
      assert(done.status === "approved", "appeal approved by second reviewer");
      assert(done.appealReviewedBy === "Appeals Admin", "appeal reviewer journaled");
      assert(done.expiresAt, "TEN-6: expiry stamped on appeal approval too");

      // Both decisions + the appeal are audited.
      const audits = await world.db.select().from(schema.auditLogs)
        .where(eq(schema.auditLogs.entityId, app.id));
      const reviewAudits = audits.filter((a: any) => a.action === "kyc.review");
      const appealAudits = audits.filter((a: any) => a.action === "kyc.appeal");
      assert(reviewAudits.length === 2, `both decisions audited (got ${reviewAudits.length})`);
      assert(appealAudits.length === 1, "appeal audited");
    } finally {
      if (prevFlag === undefined) delete process.env.KYB_SCREENING_DISABLED;
      else process.env.KYB_SCREENING_DISABLED = prevFlag;
    }
  },
};
// === END W46 kyc ===
