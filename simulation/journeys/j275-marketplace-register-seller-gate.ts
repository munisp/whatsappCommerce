/**
 * === W40 tenancy (Coder A, TEN-11) ===
 * J275 — marketplace.registerSeller is no longer an anonymous arbitrary-
 * tenant sink for bank details:
 *   1. Anonymous registration → UNAUTHORIZED.
 *   2. Authenticated merchant registering into SOMEONE ELSE's tenant →
 *      FORBIDDEN (own-tenant only).
 *   3. Own tenant WITHOUT an approved KYB → PRECONDITION_FAILED.
 *   4. Partial bank details (account number without bank code/name) →
 *      BAD_REQUEST; a malformed account number is rejected by validation.
 *   5. Own tenant + approved KYB + complete valid bank details → registered
 *      as 'pending' in the caller's OWN tenant.
 */
import { and, eq } from "drizzle-orm";
import { SUPPLIER_TENANT_ID, TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, publicCaller, seedApprovedKyb, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J275",
  name: "registerSeller auth + own-tenant + KYB + bank validation (TEN-11)",
  feature: "anonymous/cross-tenant/no-KYB registration rejected; complete bank set validated; own-tenant KYB-passed registration works",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const pub = await publicCaller();

    // ── 1. Anonymous arbitrary-tenant registration (the original hole) ──
    await expectTrpcError(
      pub.marketplace.registerSeller({
        tenantId: TENANT_ID,
        businessName: "Drive-By Seller Co",
        ownerPhone: "2348012200001",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
      }),
      "UNAUTHORIZED",
      "anonymous registration",
    );

    // ── 2. Authenticated but cross-tenant ────────────────────────────────
    const outsider = await tenantCaller(SUPPLIER_TENANT_ID, { userId: 2751 });
    await expectTrpcError(
      outsider.marketplace.registerSeller({
        tenantId: TENANT_ID,
        businessName: "Cross Tenant Seller Co",
        ownerPhone: "2348012200002",
      }),
      "FORBIDDEN",
      "cross-tenant registration",
    );

    // ── 3. Own tenant, no approved KYB ───────────────────────────────────
    // === W40 merger fix-forward (Coder A's documented fix): use a DEDICATED
    // tenant with no KYB — J56/J173 legitimately seed approved KYB for the
    // shared TENANT_ID, so asserting "no approved KYB" against TENANT_ID is
    // order-dependent and wrong.
    const NO_KYB_TENANT = "sim-w40-nokyb";
    const now = new Date();
    await world.db.insert(schema.tenants).values({
      id: NO_KYB_TENANT, name: "J275 No-KYB", slug: NO_KYB_TENANT, status: "active",
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
    const noKyb = await tenantCaller(NO_KYB_TENANT, { userId: 2752 });
    await expectTrpcError(
      noKyb.marketplace.registerSeller({
        tenantId: NO_KYB_TENANT,
        businessName: "Unvetted Seller Co",
        ownerPhone: "2348012200003",
      }),
      "PRECONDITION_FAILED",
      "registration without approved KYB",
    );
    // === END W40 merger fix ===

    // ── 4. Bank validation (KYB now seeded for TENANT_ID) ────────────────
    await seedApprovedKyb(world, TENANT_ID, "J275 Merchant Ltd");
    const merchant = await tenantCaller(TENANT_ID, { userId: 2753 });
    await expectTrpcError(
      merchant.marketplace.registerSeller({
        tenantId: TENANT_ID,
        businessName: "Partial Bank Co",
        ownerPhone: "2348012200004",
        bankAccountNumber: "0123456789", // missing bankCode + bankName
      }),
      "BAD_REQUEST",
      "partial bank details",
    );
    await expectTrpcError(
      merchant.marketplace.registerSeller({
        tenantId: TENANT_ID,
        businessName: "Bad Account Co",
        ownerPhone: "2348012200005",
        bankAccountNumber: "ABC-123",
        bankCode: "058",
        bankName: "GTBank",
      }),
      "BAD_REQUEST",
      "malformed bank account number",
    );

    // ── 5. Own tenant + KYB + complete bank set → pending ────────────────
    const ok = await merchant.marketplace.registerSeller({
      tenantId: TENANT_ID,
      businessName: "Vetted Seller Co",
      ownerPhone: "2348012200006",
      bankAccountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
    });
    assert(ok.status === "pending" && typeof ok.id === "string", "valid registration lands pending");
    const [row] = await world.db.select().from(schema.marketplaceSellers)
      .where(and(eq(schema.marketplaceSellers.id, ok.id), eq(schema.marketplaceSellers.tenantId, TENANT_ID)));
    assert(row, "seller row is in the caller's OWN tenant");
    // W40 merger fix-forward: bank set lives in the bankAccount jsonb column.
    const bank = row.bankAccount as any;
    assert(bank?.accountNumber === "0123456789" && bank?.bankCode === "058" && bank?.bankName === "GTBank",
      "bank set stored completely");

    // No drive-by rows leaked into TENANT_ID from the rejected attempts.
    const leaked = await world.db.select().from(schema.marketplaceSellers)
      .where(and(eq(schema.marketplaceSellers.tenantId, TENANT_ID), eq(schema.marketplaceSellers.businessName, "Drive-By Seller Co")));
    assert(leaked.length === 0, "rejected anonymous registration wrote nothing");
  },
};
