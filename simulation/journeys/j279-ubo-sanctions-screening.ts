/**
 * === W40 TEN-8 (Coder B) ===
 * J279 — UBO fields are screened through the SAME fail-closed sanctions path.
 *
 *   1. A KYB application whose UBO matches the (bundled, dev/test-only)
 *      sanctions list gets recommendation=reject persisted at draft save —
 *      submit is blocked AND admin approval is blocked (fail closed).
 *   2. A clean UBO is screened too (note journaled for reviewer
 *      transparency) and does NOT block approval.
 *   3. pep_declared is captured (advisory — no PEP list vendor; scope note
 *      in compliance/index.ts).
 *
 * The sim defaults KYB_SCREENING_DISABLED=true, so this journey explicitly
 * enables screening (NODE_ENV=test keeps the bundled list legal).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J279",
  name: "UBO screened fail-closed (TEN-8)",
  feature: "uboName/uboDob/pepDeclared captured on KYB; UBO sanctions hit → reject at draft save blocks submit + approval; clean UBO does not block",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    process.env.TEMPORAL_ADDRESS = "127.0.0.1:1";
    const prevFlag = process.env.KYB_SCREENING_DISABLED;
    process.env.KYB_SCREENING_DISABLED = "false";
    try {
      const started = await admin.onboarding.start({ name: "UBO Screen Store", plan: "starter" });
      const tenantId = started.tenantId;
      const tenant = await tenantCaller(tenantId, { userId: 2791 });

      // ── 1. UBO on the sanctions list → reject, submit + approve blocked ─
      const bad = await tenant.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
      const res = await tenant.kyc.updateApplication({
        applicationId: bad.id,
        businessName: "Totally Legit Trading Ltd",
        businessRegistrationNumber: "RC-J279-BAD",
        businessCountry: "NG",
        uboName: "Boko Haram", // bundled dev/test sanctions entry
        uboDob: "1975-01-01",
        pepDeclared: true,
      });
      assertIncludes(res.kybScreen ?? "", "recommendation=reject", "UBO hit → reject at draft save");
      assertIncludes(res.kybScreen ?? "", "UBO sanctions hit", "reject reason names the UBO screen");
      let [row] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, bad.id));
      assert(row.uboName === "Boko Haram" && row.uboDob === "1975-01-01" && row.pepDeclared === true,
        "UBO/PEP fields persisted");
      assert(row.lastScreenedAt, "lastScreenedAt journaled at draft save");

      await expectTrpcError(
        tenant.kyc.submit({ applicationId: bad.id }),
        "PRECONDITION_FAILED",
        "submit blocked by UBO reject",
      );
      await expectTrpcError(
        admin.kyc.review({ applicationId: bad.id, decision: "approved", notes: "try" }),
        "PRECONDITION_FAILED",
        "approval blocked by UBO reject (fail closed)",
      );
      [row] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, bad.id));
      assert(row.status !== "approved", "application NOT approved after UBO hit");

      // ── 2. Clean UBO → screened, journaled, approval not blocked ───────
      const good = await tenant.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
      const res2 = await tenant.kyc.updateApplication({
        applicationId: good.id,
        businessName: "Clean Merchant Ltd",
        businessRegistrationNumber: "RC-J279-OK",
        businessCountry: "NG",
        uboName: "Grace Hopper",
      });
      assert(res2.kybScreen && !res2.kybScreen.includes("recommendation=reject"),
        "clean UBO does not reject");
      assertIncludes(res2.kybScreen ?? "", "UBO Grace Hopper screened — no sanctions hits",
        "clean UBO screen journaled for reviewer transparency");
      // Registry provider is unavailable in sim → manual_review, which does
      // NOT block admin approval (only reject/degraded do).
      const review = await admin.kyc.review({ applicationId: good.id, decision: "approved", notes: "sim ok" });
      assert(review.ok, "approval succeeds with a clean UBO");
      const [goodRow] = await world.db.select().from(schema.kycApplications)
        .where(eq(schema.kycApplications.id, good.id));
      assert(goodRow.status === "approved" && goodRow.lastScreenedAt, "approved with screening journaled");
      void randomUUID;
    } finally {
      if (prevFlag === undefined) delete process.env.KYB_SCREENING_DISABLED;
      else process.env.KYB_SCREENING_DISABLED = prevFlag;
    }
  },
};
