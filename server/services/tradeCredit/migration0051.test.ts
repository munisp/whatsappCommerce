/**
 * W14 migration shape — drizzle/0051_bureau_facilities.sql + journal idx 51 +
 * snapshot consistency. Guards the hand-written migration against drift from
 * drizzle/schema.ts. The credit_facilities / credit_accounts column shapes
 * asserted here are the CONTRACT consumed by W14-C2.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0051_bureau_facilities.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0051_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0050_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0051_bureau_facilities.sql", () => {
  it("alters credit_accounts with the bureau consent + facility columns", () => {
    expect(sql).toContain('ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "bureau_consent_at" timestamp');
    expect(sql).toContain('ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "bureau_consent_ref" varchar(64)');
    expect(sql).toContain('ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "facility_id" varchar(36)');
  });

  it("creates bureau_report_log with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "bureau_report_log"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"account_id" varchar(36) NOT NULL',
      '"event_type" varchar(30) NOT NULL',
      '"bureau" varchar(20) NOT NULL',
      '"status" varchar(20) DEFAULT \'pending\' NOT NULL',
      '"payload" jsonb',
      '"response" jsonb',
      '"created_at" timestamp DEFAULT now() NOT NULL',
      '"updated_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("creates credit_facilities with the contract columns (W14-C2 contract)", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credit_facilities"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"lender_name" varchar(255) NOT NULL',
      '"facility_ref" varchar(64) NOT NULL',
      '"commitment_cents" bigint NOT NULL',
      '"currency" varchar(3) DEFAULT \'NGN\' NOT NULL',
      '"advance_rate_bps" integer DEFAULT 8000 NOT NULL',
      '"covenants" jsonb',
      '"status" varchar(20) DEFAULT \'active\' NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
      '"updated_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("has the required indexes", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "bureau_report_log_account_idx" ON "bureau_report_log" USING btree ("account_id")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "bureau_report_log_status_idx" ON "bureau_report_log" USING btree ("status")');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "credit_facilities_ref_uniq" ON "credit_facilities" USING btree ("facility_ref")');
  });
});

describe("drizzle meta (idx 51)", () => {
  it("journal has the 0051 entry chained after 0050", () => {
    const e50 = journal.entries.find((e: any) => e.idx === 50);
    const e51 = journal.entries.find((e: any) => e.idx === 51);
    expect(e50?.tag).toBe("0050_credit_mandates");
    expect(e51?.tag).toBe("0051_bureau_facilities");
    expect(e51.when).toBeGreaterThan(e50.when);
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(51); // 0052+ may follow
  });

  it("snapshot 0051 prevId chains to snapshot 0050 id", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries the new tables and credit_accounts columns", () => {
    expect(snapshot.tables["public.bureau_report_log"]).toBeDefined();
    expect(snapshot.tables["public.credit_facilities"]).toBeDefined();
    const ca = snapshot.tables["public.credit_accounts"].columns;
    expect(ca.bureau_consent_at?.type).toBe("timestamp");
    expect(ca.bureau_consent_ref?.type).toBe("varchar(64)");
    expect(ca.facility_id?.type).toBe("varchar(36)");
    const brl = snapshot.tables["public.bureau_report_log"];
    expect(Object.keys(brl.columns)).toEqual([
      "id", "account_id", "event_type", "bureau", "status", "payload", "response", "created_at", "updated_at",
    ]);
    expect(brl.indexes.bureau_report_log_account_idx).toBeDefined();
    expect(brl.indexes.bureau_report_log_status_idx).toBeDefined();
    const cf = snapshot.tables["public.credit_facilities"];
    expect(cf.columns.advance_rate_bps.default).toBe(8000);
    expect(cf.columns.currency.default).toBe("'NGN'");
    expect(cf.indexes.credit_facilities_ref_uniq.isUnique).toBe(true);
  });
});

describe("schema.ts alignment", () => {
  it("exports bureauReportLog and creditFacilities pgTables", () => {
    expect(schemaTs).toContain('pgTable("bureau_report_log"');
    expect(schemaTs).toContain('pgTable("credit_facilities"');
    expect(schemaTs).toContain('varchar("account_id", { length: 36 })');
    expect(schemaTs).toContain('varchar("facility_ref", { length: 64 })');
    expect(schemaTs).toContain('integer("advance_rate_bps")');
  });

  it("creditAccounts carries the new consent/facility columns", () => {
    expect(schemaTs).toContain('timestamp("bureau_consent_at")');
    expect(schemaTs).toContain('varchar("bureau_consent_ref", { length: 64 })');
    expect(schemaTs).toContain('varchar("facility_id", { length: 36 })');
  });
});
