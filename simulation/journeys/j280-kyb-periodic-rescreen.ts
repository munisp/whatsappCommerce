/**
 * === W40 TEN-8 (Coder B) ===
 * J280 — Periodic re-screening sweep (wired to /api/scheduled/kyb-rescreen).
 *
 *   1. The sweep re-screens every non-terminal KYB application through the
 *      same fail-closed path and journals lastScreenedAt; a clean merchant
 *      stays approved.
 *   2. When a previously-clean merchant's UBO later matches the sanctions
 *      list, the next sweep returns reject → the application is moved to
 *      under_review (fail closed — never left approved) and an audit row
 *      (kyb.rescreen.reject) is written.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J280",
  name: "KYB periodic re-screen sweep (TEN-8)",
  feature: "sweep journals lastScreenedAt; new sanctions hit moves approved application to under_review + audit row",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    process.env.TEMPORAL_ADDRESS = "127.0.0.1:1";
    const prevFlag = process.env.KYB_SCREENING_DISABLED;
    process.env.KYB_SCREENING_DISABLED = "false";
    try {
      const started = await admin.onboarding.start({ name: "Rescreen Store", plan: "starter" });
      const tenantId = started.tenantId;

      // Seed an APPROVED KYB application (as if reviewed pre-W40 — never
      // screened since approval, lastScreenedAt null).
      const appId = randomUUID();
      await world.db.insert(schema.kycApplications).values({
        id: appId, tenantId, type: "kyb", status: "approved",
        businessName: "Rescreen Store Ltd",
        businessRegistrationNumber: "RC-J280",
        businessCountry: "NG",
        uboName: "Marie Curie",
        approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      });

      // ── 1. Clean re-screen: timestamp journaled, approval preserved ────
      const { runKybRescreenSweep } = await import("../../server/services/kycPrivacy");
      const r1 = await runKybRescreenSweep(world.db);
      assert(r1.screened >= 1 && r1.rejected === 0, `clean sweep screened (got ${JSON.stringify(r1)})`);
      let [row] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, appId));
      assert(row.lastScreenedAt, "lastScreenedAt journaled by the sweep");
      assert(row.status === "approved", "clean merchant stays approved");
      assert((row.reviewNotes ?? "").includes("[kyb-rescreen]"), "re-screen note journaled");
      const firstScreenedAt = row.lastScreenedAt;

      // ── 2. UBO newly listed → reject → under_review + audit ────────────
      await world.db.update(schema.kycApplications)
        .set({ uboName: "Ansaru", updatedAt: new Date() }) // bundled dev/test list entry
        .where(eq(schema.kycApplications.id, appId));
      const r2 = await runKybRescreenSweep(world.db);
      assert(r2.rejected >= 1, `sweep caught the new UBO hit (got ${JSON.stringify(r2)})`);
      [row] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, appId));
      assert(row.status === "under_review", `fail closed: approved → under_review on new hit (got ${row.status})`);
      assert(row.lastScreenedAt && row.lastScreenedAt.getTime() >= (firstScreenedAt?.getTime() ?? 0),
        "lastScreenedAt advanced");
      assert((row.reviewNotes ?? "").includes("recommendation=reject"), "reject note persisted");

      const audits = await world.db.select().from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, "kyb.rescreen.reject"));
      assert(audits.some((a: any) => a.entityId === appId), "kyb.rescreen.reject audit row written");
    } finally {
      if (prevFlag === undefined) delete process.env.KYB_SCREENING_DISABLED;
      else process.env.KYB_SCREENING_DISABLED = prevFlag;
    }
  },
};
