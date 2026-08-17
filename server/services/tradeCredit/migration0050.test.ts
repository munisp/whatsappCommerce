/**
 * W13 migration shape — drizzle/0050_credit_mandates.sql + journal idx 50 +
 * snapshot consistency. Guards the hand-written migration against drift from
 * drizzle/schema.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0050_credit_mandates.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0050_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0049_snapshot.json"), "utf8"));

describe("0050_credit_mandates.sql", () => {
  it("creates payment_mandates with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "payment_mandates"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"tenantId" varchar(36) NOT NULL',
      '"provider" varchar(30) NOT NULL',
      '"mandateRef" varchar(128) NOT NULL',
      '"customerRef" varchar(128)',
      '"status" varchar(20) DEFAULT \'pending\' NOT NULL',
      '"metadata" jsonb',
      '"createdAt" timestamp DEFAULT now() NOT NULL',
      '"updatedAt" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("creates credit_limit_history with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credit_limit_history"');
    for (const frag of [
      '"accountId" uuid NOT NULL',
      '"oldLimitCents" bigint NOT NULL',
      '"newLimitCents" bigint NOT NULL',
      '"score" integer',
      '"reason" varchar(255)',
    ]) expect(sql).toContain(frag);
  });

  it("alters credit_accounts with mandate + suspension columns", () => {
    expect(sql).toContain('ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "mandate_id" varchar(36)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "suspended" boolean DEFAULT false NOT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "suspended_at" timestamp');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "suspension_reason" varchar(255)');
  });

  it("has the required indexes + foreign keys", () => {
    expect(sql).toContain('"payment_mandates_tenant_status_idx"');
    expect(sql).toContain('"payment_mandates_tenant_provider_ref_uniq"');
    expect(sql).toContain('UNIQUE INDEX');
    expect(sql).toContain('"credit_limit_history_account_idx"');
    expect(sql).toContain('REFERENCES "public"."tenants"("id")');
    expect(sql).toContain('REFERENCES "public"."credit_accounts"("id")');
  });
});

describe("drizzle meta", () => {
  it("journal registers idx 50 as 0050_credit_mandates", () => {
    // idx 50 registered (newer waves append after it — find by idx, not position).
    const entry = journal.entries.find((e: any) => e.idx === 50);
    expect(entry).toMatchObject({ idx: 50, tag: "0050_credit_mandates", breakpoints: true });
    // Monotonic idx chain.
    expect(journal.entries.map((e: any) => e.idx)).toEqual(
      [...journal.entries.map((e: any) => e.idx)].sort((a: number, b: number) => a - b),
    );
  });

  it("snapshot chains from 0049 and contains the new tables + columns", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.tables["public.payment_mandates"]).toBeTruthy();
    expect(snapshot.tables["public.credit_limit_history"]).toBeTruthy();
    const ca = snapshot.tables["public.credit_accounts"].columns;
    for (const col of ["mandate_id", "suspended", "suspended_at", "suspension_reason"]) {
      expect(ca[col], `credit_accounts.${col}`).toBeTruthy();
    }
    expect(snapshot.tables["public.payment_mandates"].indexes["payment_mandates_tenant_provider_ref_uniq"].isUnique).toBe(true);
  });
});
