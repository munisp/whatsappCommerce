/**
 * J55 — IDOR sweep. An authenticated tenant-A user sweeps tenant-B resources
 * across four routers with tenant-B ids: analyticsBI cohorts (read + write),
 * inventory stock reads + reserveStock mutation, kyc getApplication +
 * uploadDocument. Every call must fail FORBIDDEN and — the hard part — the
 * database must be byte-identical afterwards (row-count diff assertion over
 * every table the attacks could have touched).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_PRODUCTS, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J55",
  name: "IDOR sweep",
  feature: "cross-tenant 403s + zero-row mutation",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const attacker = await tenantCaller(TENANT_ID, { userId: 77 });
    const admin = await adminCaller();

    // Seed legitimate tenant-B state the attacker will aim at.
    await admin.analyticsBI.upsertCohort({
      tenantId: SUPPLIER_TENANT_ID,
      cohortMonth: "2026-07",
      totalCustomers: 42,
      retentionByMonth: { m0: 1, m1: 0.5 },
      totalRevenue: "125000.00",
    });
    const appB = await admin.kyc.getOrCreateApplication({ tenantId: SUPPLIER_TENANT_ID, type: "kyb" });
    assert(appB?.id, "tenant-B KYB application exists");

    // ── Snapshot: row counts + key mutable values BEFORE the sweep ─────────
    const snapshot = async () => {
      const count = async (table: any) => (await world.db.select().from(table)).length;
      const [crates] = await world.db
        .select({ stock: schema.products.stockQuantity })
        .from(schema.products)
        .where(eq(schema.products.id, SUPPLIER_PRODUCTS.crates.id))
        .limit(1);
      const [cohort] = await world.db
        .select()
        .from(schema.cohortSnapshots)
        .where(eq(schema.cohortSnapshots.tenantId, SUPPLIER_TENANT_ID))
        .limit(1);
      return {
        cohorts: await count(schema.cohortSnapshots),
        churn: await count(schema.churnPredictions),
        inventorySnapshots: await count(schema.inventorySnapshots),
        inventorySyncLog: await count(schema.inventorySyncLog),
        kycApps: await count(schema.kycApplications),
        kycDocs: await count(schema.kycDocuments),
        cratesStock: crates.stock,
        cohortBTotal: cohort?.totalCustomers,
        cohortBRevenue: cohort?.totalRevenue,
      };
    };
    const before = await snapshot();

    // ── analyticsBI: read + write with tenant-B id ─────────────────────────
    await expectTrpcError(attacker.analyticsBI.listCohorts({ tenantId: SUPPLIER_TENANT_ID }), "FORBIDDEN", "listCohorts(B)");
    await expectTrpcError(
      attacker.analyticsBI.upsertCohort({ tenantId: SUPPLIER_TENANT_ID, cohortMonth: "2026-07", totalCustomers: 1, retentionByMonth: {} }),
      "FORBIDDEN",
      "upsertCohort(B)",
    );
    await expectTrpcError(attacker.analyticsBI.biSummary({ tenantId: SUPPLIER_TENANT_ID }), "FORBIDDEN", "biSummary(B)");

    // ── inventory: stock reads + destructive reserveStock ─────────────────
    await expectTrpcError(attacker.inventory.getStockLevels({ tenantId: SUPPLIER_TENANT_ID }), "FORBIDDEN", "getStockLevels(B)");
    await expectTrpcError(attacker.inventory.getStockAlerts({ tenantId: SUPPLIER_TENANT_ID }), "FORBIDDEN", "getStockAlerts(B)");
    await expectTrpcError(
      attacker.inventory.reserveStock({ tenantId: SUPPLIER_TENANT_ID, productId: SUPPLIER_PRODUCTS.crates.id, qty: 4999 }),
      "FORBIDDEN",
      "reserveStock(B) — attempted 4,999-unit theft",
    );
    await expectTrpcError(
      attacker.inventory.releaseReservation({ tenantId: SUPPLIER_TENANT_ID, productId: SUPPLIER_PRODUCTS.crates.id, qty: 100 }),
      "FORBIDDEN",
      "releaseReservation(B)",
    );
    await expectTrpcError(attacker.inventory.syncFromOdoo({ tenantId: SUPPLIER_TENANT_ID }), "FORBIDDEN", "syncFromOdoo(B)");

    // ── kyc: application read + document upload with B's application id ───
    await expectTrpcError(attacker.kyc.getApplication({ applicationId: appB.id }), "FORBIDDEN", "getApplication(B)");
    await expectTrpcError(
      attacker.kyc.uploadDocument({
        applicationId: appB.id,
        documentType: "business_registration",
        fileBase64: Buffer.from("forged certificate").toString("base64"),
        fileName: "forged.pdf",
      }),
      "FORBIDDEN",
      "uploadDocument(B)",
    );
    await expectTrpcError(attacker.kyc.submit({ applicationId: appB.id }), "FORBIDDEN", "submit(B)");
    await expectTrpcError(
      attacker.kyc.updateApplication({ applicationId: appB.id, businessName: "Hijacked Ltd" }),
      "FORBIDDEN",
      "updateApplication(B)",
    );

    // ── Hard DB diff: NOTHING changed ──────────────────────────────────────
    const after = await snapshot();
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      `zero rows mutated during the sweep\nbefore: ${JSON.stringify(before)}\nafter:  ${JSON.stringify(after)}`,
    );

    // ── Control: the same caller reads its OWN tenant fine ────────────────
    const own = await attacker.inventory.getStockLevels({ tenantId: TENANT_ID });
    assert(Array.isArray(own) && own.length > 0, "attacker can still read its own tenant's stock");
    const ownKyc = await attacker.kyc.getOrCreateApplication({ tenantId: TENANT_ID, type: "kyb" });
    assert(ownKyc?.id, "attacker can create its own KYB application");
  },
};
