// === W46 kyc (Coder A) ===
/**
 * J389 — TEN-9: scoped staff capability model.
 *  finance role  → passes moneyProcedure, denied catalog mutations.
 *  catalog role  → passes catalog mutations, denied moneyProcedure.
 *  operator role → retains legacy catalog + money access (documented compat).
 *  Cross-scope denials are FORBIDDEN; pass-cases reach the handler
 *  (NOT_FOUND / success — not FORBIDDEN).
 */
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

async function expectCode(fn: () => Promise<unknown>, re: RegExp, label: string) {
  try {
    await fn();
  } catch (e: any) {
    assert(re.test(e?.message ?? ""), `${label} (got: ${e?.message ?? e})`);
    return;
  }
  throw new Error(`${label} — expected throw, got success`);
}

export const journey: Journey = {
  id: "J389",
  name: "Scoped finance/catalog staff roles enforced",
  feature: "TEN-9 capability model in moneyProcedure + catalog mutations",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const tenantId = `j389-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.tenants).values({
      id: tenantId, name: "J389 Scoped Store", slug: tenantId, status: "active",
    }).onConflictDoNothing();
    // W46 merger fix: split the multi-row insert — the PGlite-backed driver
    // truncates/fails on batched .values([...]) for tenant_memberships.
    for (const row of [
      { tenantId, userId: "3891", role: "finance" },
      { tenantId, userId: "3892", role: "catalog" },
      { tenantId, userId: "3893", role: "operator" },
    ]) {
      await world.db.insert(schema.tenantMemberships).values(row).onConflictDoNothing();
    }

    const finance = await tenantCaller(tenantId, { userId: 3891 });
    const catalog = await tenantCaller(tenantId, { userId: 3892 });
    const operator = await tenantCaller(tenantId, { userId: 3893 });
    const ghost = randomUUID();

    // finance → moneyProcedure passes the role gate (handler NOT_FOUND is fine).
    await expectCode(
      () => finance.scheduledPayments.cancel({ tenantId, id: ghost }),
      /Scheduled payment not found/i,
      "finance role admitted to moneyProcedure",
    );
    // catalog → moneyProcedure denied at the role gate.
    await expectCode(
      () => catalog.scheduledPayments.cancel({ tenantId, id: ghost }),
      /moneyProcedure requires tenant role/i,
      "catalog role refused by moneyProcedure",
    );
    // finance → catalog mutation denied (no catalog capability).
    await expectCode(
      () => finance.product.create({ tenantId, sku: "J389-F", name: "Nope", price: "10.00" }),
      /requires the "catalog" capability/i,
      "finance role refused catalog mutation",
    );
    // catalog → catalog mutation succeeds.
    const created = await catalog.product.create({ tenantId, sku: `J389-${randomUUID().slice(0, 6)}`, name: "Catalog Widget", price: "10.00" });
    assert(created.id, "catalog role creates products");
    // operator → legacy catalog access retained (documented compat).
    const opCreated = await operator.product.create({ tenantId, sku: `J389-OP-${randomUUID().slice(0, 6)}`, name: "Operator Widget", price: "5.00" });
    assert(opCreated.id, "operator retains catalog capability (legacy compat)");
    // operator → moneyProcedure still admitted (legacy compat) — reaches handler.
    await expectCode(
      () => operator.scheduledPayments.cancel({ tenantId, id: ghost }),
      /Scheduled payment not found/i,
      "operator retains moneyProcedure access (legacy compat)",
    );

    // Role→capability map sanity.
    const { roleHasCapability } = await import("../../server/services/capabilities");
    assert(roleHasCapability("owner", "finance") && roleHasCapability("owner", "catalog"), "owner all");
    assert(roleHasCapability("finance", "finance") && !roleHasCapability("finance", "catalog"), "finance scoped");
    assert(roleHasCapability("catalog", "catalog") && !roleHasCapability("catalog", "finance"), "catalog scoped");
    assert(!roleHasCapability("analyst", "finance") && roleHasCapability("analyst", "reports"), "analyst read-only");
  },
};
// === END W46 kyc ===
