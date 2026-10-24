// === W64 intelligence ===
/**
 * J619 — R4 KYC OCR prefill (services/prefillService):
 *   1. An approved kyc_applications row + a kyc_documents.extractedData blob
 *      (including SECRET bvn/nin keys) → getKycPrefill returns the
 *      non-secret identity/business fields.
 *   2. bvn/nin (and their hashes) are NEVER surfaced in the prefill bundle.
 *   3. A tenant with no approved application → { available: false }
 *      (fail-open manual path).
 */
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J619",
  name: "kyc prefill: approved app + OCR extractedData → fields, secrets filtered, unavailable empty state",
  feature: "W64 intelligence R4: KYC OCR prefill service",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { getKycPrefill } = await import("../../server/services/prefillService");
    const APP_ID = "kycapp-j619-1";
    const { and, eq, ne } = await import("drizzle-orm");
    let parked: Array<{ id: string }> = [];
    try {
      // The sim seed carries an approved application for TENANT_ID with a
      // NULL approvedAt (sorts first under DESC) — park it as 'expired' so
      // getKycPrefill's "latest approved" is deterministic; restored below.
      parked = await world.db.select({ id: schema.kycApplications.id })
        .from(schema.kycApplications)
        .where(and(eq(schema.kycApplications.tenantId, TENANT_ID), eq(schema.kycApplications.status, "approved"), ne(schema.kycApplications.id, APP_ID)));
      await world.db.update(schema.kycApplications)
        .set({ status: "expired" })
        .where(and(eq(schema.kycApplications.tenantId, TENANT_ID), eq(schema.kycApplications.status, "approved"), ne(schema.kycApplications.id, APP_ID)));
      await world.db.insert(schema.kycApplications).values({
        id: APP_ID,
        tenantId: TENANT_ID,
        type: "kyb",
        status: "approved",
        applicantName: "J619 Ada Lovelace",
        applicantPhone: "2348011112222",
        applicantEmail: "ada@j619.example.com",
        businessName: "J619 Ventures Ltd",
        businessRegistrationNumber: "RC-J619",
        businessCountry: "NG",
        businessType: "limited",
        submittedAt: new Date(),
        approvedAt: new Date(),
      }).onConflictDoNothing();
      await world.db.insert(schema.kycDocuments).values([
        {
          id: "kycdoc-j619-1",
          applicationId: APP_ID,
          tenantId: TENANT_ID,
          documentType: "national_id",
          extractedData: {
            fullName: "J619 Ada Lovelace",
            dateOfBirth: "1990-01-01",
            address: "1 J619 Close, Lagos",
            // Secrets that must NEVER be surfaced:
            bvn: "222233334444",
            nin: "555566667777",
          },
        },
        {
          id: "kycdoc-j619-2",
          applicationId: APP_ID,
          tenantId: TENANT_ID,
          documentType: "bank_statement",
          extractedData: {
            bankName: "J619 Bank",
            bankAccountNumber: "0123456789",
            bankAccountName: "J619 Ventures Ltd",
          },
        },
      ]).onConflictDoNothing();

      // ── 1. Prefill bundle populated from applicant + merged OCR docs ───
      const prefill = await getKycPrefill(world.db, TENANT_ID);
      assert(prefill.available === true, "prefill available for approved tenant");
      assert(prefill.fullName === "J619 Ada Lovelace", `fullName (got ${prefill.fullName})`);
      assert(prefill.phone === "2348011112222", `phone (got ${prefill.phone})`);
      assert(prefill.dateOfBirth === "1990-01-01", `dob from extractedData (got ${prefill.dateOfBirth})`);
      assert(prefill.address === "1 J619 Close, Lagos", `address (got ${prefill.address})`);
      assert(prefill.businessName === "J619 Ventures Ltd", `businessName (got ${prefill.businessName})`);
      assert(prefill.businessRegistrationNumber === "RC-J619", `rc number (got ${prefill.businessRegistrationNumber})`);
      assert(prefill.bankName === "J619 Bank" && prefill.bankAccountNumber === "0123456789", "bank fields from statement OCR");

      // ── 2. BVN/NIN never present in the bundle ─────────────────────────
      const json = JSON.stringify(prefill);
      assert(!json.includes("222233334444") && !json.includes("555566667777"), "BVN/NIN values absent");
      assert(!("bvn" in prefill) && !("nin" in prefill) && !("bvnHash" in prefill) && !("ninHash" in prefill), "BVN/NIN keys absent");

      // ── 3. No approved application → unavailable ───────────────────────
      const none = await getKycPrefill(world.db, "tenant-j619-none");
      assert(none.available === false, `no approved app → available:false (got ${JSON.stringify(none)})`);
    } finally {
      await world.db.execute(`DELETE FROM kyc_documents WHERE id LIKE 'kycdoc-j619-%'`).catch(() => {});
      await world.db.execute(`DELETE FROM kyc_applications WHERE id = 'kycapp-j619-1'`).catch(() => {});
      for (const row of parked ?? []) {
        await world.db.update(schema.kycApplications).set({ status: "approved" })
          .where(eq(schema.kycApplications.id, row.id)).catch(() => {});
      }
    }
  },
};
