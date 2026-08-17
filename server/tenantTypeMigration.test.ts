/**
 * tenantTypeMigration.test.ts — W12 migration SQL sanity, journal/snapshot
 * wiring, and schema-level tenant classification assertions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const MIGRATION = path.join(root, "drizzle", "0049_tenant_type_memberships.sql");
const sql = readFileSync(MIGRATION, "utf8");
const journal = JSON.parse(readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8"));
const schemaSrc = readFileSync(path.join(root, "drizzle", "schema.ts"), "utf8");

describe("0049 migration SQL", () => {
  it("adds tenants.tenantType as varchar default 'retailer' NOT NULL", () => {
    expect(sql).toMatch(/ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "tenantType" varchar\(20\) DEFAULT 'retailer' NOT NULL/);
  });
  it("backfills supplier-profile tenants to 'hybrid'", () => {
    expect(sql).toMatch(/UPDATE "tenants" AS t SET "tenantType" = 'hybrid'/);
    expect(sql).toMatch(/FROM "supplier_profiles" AS sp/);
    expect(sql).toMatch(/WHERE sp\."tenant_id" = t\."id"/);
  });
  it("creates tenant_memberships with uuid pk and role check", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "tenant_memberships"/);
    expect(sql).toMatch(/"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    expect(sql).toMatch(/CHECK \("role" IN \('owner','operator','analyst'\)\)/);
  });
  it("enforces UNIQUE(tenantId, userId) on tenant_memberships", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "tenant_memberships_tenant_user_uniq" ON "tenant_memberships"[^;]*\("tenantId","userId"\)/);
  });
  it("backfills owner memberships from users.tenantId", () => {
    expect(sql).toMatch(/INSERT INTO "tenant_memberships" \("tenantId", "userId", "role"\)/);
    expect(sql).toMatch(/SELECT u\."tenantId", u\."id"::varchar, 'owner'/);
    expect(sql).toMatch(/FROM "users" AS u/);
    expect(sql).toMatch(/WHERE u\."tenantId" IS NOT NULL/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });
  it("creates session_revocations (jti pk, userId, expiresAt)", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "session_revocations"/);
    expect(sql).toMatch(/"jti" varchar\(64\) PRIMARY KEY NOT NULL/);
    expect(sql).toMatch(/"userId" varchar\(36\)/);
    expect(sql).toMatch(/"expiresAt" timestamp NOT NULL/);
  });
  it("uses statement breakpoints following the existing migration pattern", () => {
    expect(sql.split("--> statement-breakpoint").length).toBeGreaterThan(5);
  });
});

describe("drizzle journal + snapshot", () => {
  it("registers idx 49 / tag 0049_tenant_type_memberships after idx 48", () => {
    // W13 note: later waves append to the journal (0050_credit_mandates etc.),
    // so assert the 0049 ENTRY itself rather than the journal tail.
    const entries = journal.entries;
    const entry = entries.find((e: any) => e.idx === 49);
    expect(entries[entries.indexOf(entry) - 1].idx).toBe(48);
    expect(entry.tag).toBe("0049_tenant_type_memberships");
    expect(existsSync(path.join(root, "drizzle", `${entry.tag}.sql`))).toBe(true);
  });
  it("ships a 0049 snapshot containing the new tables and column", () => {
    const snapPath = path.join(root, "drizzle", "meta", "0049_snapshot.json");
    expect(existsSync(snapPath)).toBe(true);
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    expect(snap.tables["public.tenant_memberships"]).toBeTruthy();
    expect(snap.tables["public.session_revocations"]).toBeTruthy();
    expect(snap.tables["public.tenants"].columns.tenantType).toMatchObject({
      type: "varchar(20)",
      notNull: true,
      default: "'retailer'",
    });
  });
});

describe("schema tenant classification", () => {
  it("declares tenantTypeEnum with retailer/supplier/hybrid", () => {
    expect(schemaSrc).toMatch(/tenantTypeEnum = \["retailer", "supplier", "hybrid"\] as const/);
  });
  it("declares tenants.tenantType with retailer default", () => {
    expect(schemaSrc).toMatch(/tenantType: varchar\("tenantType", \{ length: 20 \}\)\.default\("retailer"\)\.notNull\(\)/);
  });
  it("declares tenantMemberships and sessionRevocations tables", () => {
    expect(schemaSrc).toMatch(/pgTable\("tenant_memberships"/);
    expect(schemaSrc).toMatch(/pgTable\("session_revocations"/);
  });
  it("exposes typed TenantType/MembershipRole unions", () => {
    expect(schemaSrc).toMatch(/membershipRoleEnum = \["owner", "operator", "analyst"\] as const/);
  });
});
