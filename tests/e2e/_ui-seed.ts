/**
 * Seed data + mint per-role session tokens for the UI E2E run.
 * Writes .qa/ui-tokens.json consumed by _ui-driver.mjs. Re-runnable (ON CONFLICT).
 */
import { seedUser, mintPlatformSession, getSql, closeSql } from "./helpers/stack";
import { writeFileSync } from "node:fs";

const TENANT_A = "qa-tenant-a";
const TENANT_B = "qa-tenant-b";

async function main() {
  const sql = getSql();

  // Tenants (FK target for memberships)
  for (const [id, name, slug] of [[TENANT_A, "QA Tenant A", "qa-tenant-a"], [TENANT_B, "QA Tenant B", "qa-tenant-b"]]) {
    await sql`INSERT INTO tenants (id, name, slug) VALUES (${id}, ${name}, ${slug}) ON CONFLICT (id) DO NOTHING`;
  }

  // Users (role + tenantId resolved server-side from these rows)
  const admin = await seedUser({ openId: "qa-admin", name: "QA Admin", role: "admin" });
  const owner = await seedUser({ openId: "qa-owner", name: "QA Owner A", role: "user", tenantId: TENANT_A });
  const operator = await seedUser({ openId: "qa-operator", name: "QA Operator A", role: "operator", tenantId: TENANT_A });
  const analyst = await seedUser({ openId: "qa-analyst", name: "QA Analyst A", role: "analyst", tenantId: TENANT_A });
  const bOwner = await seedUser({ openId: "qa-bowner", name: "QA Owner B", role: "user", tenantId: TENANT_B });

  // Memberships (owner/operator/analyst/finance are MEMBERSHIP roles; needed for money/operator procedures)
  const mem: [number, string, string][] = [
    [owner, TENANT_A, "owner"], [operator, TENANT_A, "operator"], [analyst, TENANT_A, "analyst"], [bOwner, TENANT_B, "owner"],
  ];
  for (const [uid, tid, role] of mem) {
    await sql`INSERT INTO tenant_memberships ("tenantId","userId","role") VALUES (${tid}, ${String(uid)}, ${role})
              ON CONFLICT ("tenantId","userId") DO UPDATE SET "role" = EXCLUDED."role"`;
  }

  // A couple of products for tenant A so inventory/product pages have real rows (best-effort).
  let products = 0;
  try {
    for (const [pid, name, price, sku] of [["qa-prod-1", "QA Rice 5kg", "4500.00", "QA-RICE-5KG"], ["qa-prod-2", "QA Palm Oil 1L", "1800.00", "QA-OIL-1L"]]) {
      await sql`INSERT INTO products (id,"tenantId",name,sku,price,currency,"stockQuantity","createdAt","updatedAt")
                VALUES (${pid}, ${TENANT_A}, ${name}, ${sku}, ${price}, 'NGN', 50, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`;
      products++;
    }
  } catch (e) { console.warn("product seed skipped:", (e as Error).message); }

  const tok = async (openId: string, name: string) => ({ openId, token: await mintPlatformSession(openId, name) });
  const out = {
    tenantA: TENANT_A, tenantB: TENANT_B, productsSeeded: products,
    roles: {
      admin: await tok("qa-admin", "QA Admin"),
      owner: await tok("qa-owner", "QA Owner A"),
      operator: await tok("qa-operator", "QA Operator A"),
      analyst: await tok("qa-analyst", "QA Analyst A"),
      bOwner: await tok("qa-bowner", "QA Owner B"),
    },
  };
  writeFileSync(".qa/ui-tokens.json", JSON.stringify(out, null, 2));
  console.log("seeded tenants A/B, users admin/owner/operator/analyst/bOwner, memberships, products:", products);
  console.log("tokens written to .qa/ui-tokens.json");
  await closeSql();
}
main().catch((e) => { console.error("SEED_ERROR", e); process.exit(1); });
