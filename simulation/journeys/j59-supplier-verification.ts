/**
 * J59 — Supplier verification trust flag. An unverified tenant cannot make
 * its supplier profile 'active' (creation defaults to active → gated, 403);
 * it may exist 'paused' and stays out of the directory. The directory's
 * kybVerified flag fails closed (false) for an ACTIVE supplier with no
 * approved KYB (the seeded Lagos Plastics) and flips to true once KYB is
 * approved. After verification, the new tenant activates and appears with
 * kybVerified:true.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J59",
  name: "supplier verification",
  feature: "supplier-profile KYB gate + directory trust flag",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const buyerCaller = await tenantCaller(TENANT_ID, { userId: 94 });

    const newTenant = (await admin.onboarding.start({ name: "Unverified Wholesale Ltd" })).tenantId;
    const newCaller = await tenantCaller(newTenant, { userId: 95 });

    // ── Unverified tenant: activation is gated (creation defaults active) ──
    const e = await expectTrpcError(
      newCaller.procurement.upsertSupplierProfile({ tenantId: newTenant, categories: ["gadgets"], moqCents: 50_000 }),
      "FORBIDDEN",
      "unverified supplier-profile activation",
    );
    assert(e.message.includes("KYB"), "refusal names the KYB gate");
    const noProfile = await world.db
      .select()
      .from(schema.supplierProfiles)
      .where(eq(schema.supplierProfiles.tenantId, newTenant))
      .limit(1);
    assert(noProfile.length === 0, "no profile row created by the refused activation");

    // ── Paused creation stays open (editing is not a trust surface) ────────
    const paused = await newCaller.procurement.upsertSupplierProfile({
      tenantId: newTenant,
      status: "paused",
      categories: ["gadgets"],
      moqCents: 50_000,
    });
    assert(paused.status === "paused", "profile created paused");

    // W30 merge: the world seed now grants BOTH seed tenants an approved KYB
    // (W30 auth-gates reset banner). This journey's whole subject is the
    // unverified→verified transition, so restore the pre-W30 starting state
    // for the seeded supplier first (the reset re-seeds it for later journeys).
    await world.db.delete(schema.kycApplications).where(eq(schema.kycApplications.tenantId, SUPPLIER_TENANT_ID));

    // Directory: seeded supplier present with kybVerified FALSE (no KYB app);
    // the paused unverified tenant is absent.
    const dir1 = await buyerCaller.procurement.listSuppliers({ tenantId: TENANT_ID });
    const seededEntry = dir1.find((s: any) => s.tenantId === SUPPLIER_TENANT_ID);
    assert(seededEntry, "seeded supplier listed in the directory");
    assert(seededEntry.kybVerified === false, "directory fails closed: kybVerified=false without approved KYB");
    assert(!dir1.some((s: any) => s.tenantId === newTenant), "paused unverified tenant absent from the directory");

    // ── Verify the SEEDED supplier → trust flag flips ──────────────────────
    const seededKyc = await admin.kyc.getOrCreateApplication({ tenantId: SUPPLIER_TENANT_ID, type: "kyb" });
    await admin.kyc.review({ applicationId: seededKyc.id, decision: "approved" });
    const dir2 = await buyerCaller.procurement.listSuppliers({ tenantId: TENANT_ID });
    const seededAfter = dir2.find((s: any) => s.tenantId === SUPPLIER_TENANT_ID);
    assert(seededAfter.kybVerified === true, "kybVerified=true after KYB approval");

    // ── Verify the new tenant → activation succeeds, listed + trusted ──────
    const newKyc = await newCaller.kyc.getOrCreateApplication({ tenantId: newTenant, type: "kyb" });
    await admin.kyc.review({ applicationId: newKyc.id, decision: "approved" });
    const active = await newCaller.procurement.upsertSupplierProfile({ tenantId: newTenant, status: "active" });
    assert(active.status === "active", "verified tenant activated its profile");
    const dir3 = await buyerCaller.procurement.listSuppliers({ tenantId: TENANT_ID });
    const newEntry = dir3.find((s: any) => s.tenantId === newTenant);
    assert(newEntry, "verified tenant now listed");
    assert(newEntry.kybVerified === true, "new tenant listed with kybVerified:true");
    assert(newEntry.moqCents === 50_000, "directory carries the profile terms");
  },
};
