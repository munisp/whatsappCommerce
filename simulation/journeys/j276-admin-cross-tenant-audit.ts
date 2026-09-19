/**
 * === W40 tenancy (Coder A, TEN-4) ===
 * J276 — admin cross-tenant actions write audit rows. Before W40,
 * assertTenantAccess's admin bypass was silent: a platform admin could act
 * on any tenant with zero forensic trail. Now tenant / kyc / membership /
 * marketplace admin mutations write audit_logs rows with actor, action,
 * target tenant and before/after summary:
 *   1. tenant.update (cross-tenant suspension) → tenant.update row.
 *   2. kyc.review (rejecting another tenant's KYB) → kyc.review row.
 *   3. membership.add (granting staff on another tenant) → membership.add row.
 *   4. marketplace.updateSellerStatus (suspending another tenant's seller)
 *      → marketplace.updateSellerStatus row.
 */
import { and, eq } from "drizzle-orm";
import { SUPPLIER_TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, seedApprovedKyb } from "./helpers";

async function auditRow(world: World, action: string, tenantId: string): Promise<any> {
  const schema = await import("../../drizzle/schema");
  const rows = await world.db.select().from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.tenantId, tenantId)));
  return rows[rows.length - 1] ?? null;
}

export const journey: Journey = {
  id: "J276",
  name: "admin cross-tenant actions audited (TEN-4)",
  feature: "writeAuditLog on tenant/kyc/membership/marketplace admin mutations with actor + target tenant + before/after",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    // ── 1. Cross-tenant suspension via tenant.update ─────────────────────
    await admin.tenant.update({ id: SUPPLIER_TENANT_ID, status: "suspended" });
    const t1 = await auditRow(world, "tenant.update", SUPPLIER_TENANT_ID);
    assert(t1, "tenant.update audit row written");
    assert(String(t1.actorId) === "1", `audit actor is the admin (got ${t1.actorId})`);
    assert(String(t1.summary).includes("status"), `audit summary names the lifecycle change (got ${t1.summary})`);
    assert((t1.after as any)?.status === "suspended", "audit after-state records the suspension");
    // Restore immediately so later journeys keep the supplier active.
    await admin.tenant.update({ id: SUPPLIER_TENANT_ID, status: "active" });

    // ── 2. Cross-tenant KYB adjudication ─────────────────────────────────
    const kybId = await seedApprovedKyb(world, SUPPLIER_TENANT_ID, "J276 Audit Co");
    await admin.kyc.review({ applicationId: kybId, decision: "rejected", rejectionReason: "J276 audit probe" });
    const t2 = await auditRow(world, "kyc.review", SUPPLIER_TENANT_ID);
    assert(t2, "kyc.review audit row written");
    assert((t2.after as any)?.status === "rejected" && (t2.before as any)?.status === "approved",
      `kyc.review audit has before/after status (got ${JSON.stringify(t2.before)} → ${JSON.stringify(t2.after)})`);

    // ── 3. Cross-tenant staff grant ──────────────────────────────────────
    // === W47 stakeholders === ONB-S-2: direct adds require a REAL user row.
    await world.db.insert(schema.users).values({
      id: 9276, openId: "j276-staff", name: "J276 Staff", loginMethod: "keycloak",
      role: "user", lastSignedIn: new Date(),
    }).onConflictDoNothing();
    // === END W47 stakeholders ===
    await admin.membership.add({ tenantId: SUPPLIER_TENANT_ID, userId: 9276, role: "analyst" });
    const t3 = await auditRow(world, "membership.add", SUPPLIER_TENANT_ID);
    assert(t3, "membership.add audit row written");
    assert((t3.after as any)?.role === "analyst", "membership.add audit records the granted role");

    // ── 4. Cross-tenant seller suspension ────────────────────────────────
    // Seed the seller as the supplier's own merchant (KYB already seeded
    // above — but it was rejected in step 2, so insert the row directly).
    const sellerId = `j276-seller-${Math.random().toString(36).slice(2, 8)}`;
    await world.db.insert(schema.marketplaceSellers).values({
      id: sellerId,
      tenantId: SUPPLIER_TENANT_ID,
      businessName: "J276 Seller",
      ownerPhone: "2348013300001",
      status: "active",
      commissionRate: "10.00",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await admin.marketplace.updateSellerStatus({ id: sellerId, status: "suspended" });
    const t4 = await auditRow(world, "marketplace.updateSellerStatus", SUPPLIER_TENANT_ID);
    assert(t4, "marketplace.updateSellerStatus audit row written");
    assert((t4.before as any)?.status === "active" && (t4.after as any)?.status === "suspended",
      "seller audit has before/after status");

    // Cleanup: staff grant + seller row.
    // === W40 merger fix-forward (Coder A's documented fix): membership.remove
    // refuses to remove the last owner; delete the membership row directly.
    await world.db.delete(schema.tenantMemberships).where(and(
      eq(schema.tenantMemberships.tenantId, SUPPLIER_TENANT_ID),
      eq(schema.tenantMemberships.userId, "9276"),
    ));
    // === END W40 merger fix ===
    await world.db.delete(schema.marketplaceSellers).where(eq(schema.marketplaceSellers.id, sellerId));
  },
};
