/**
 * W18 migration shape — drizzle/0059_manufacturer_credit_programs.sql +
 * journal idx 59 + snapshot consistency. Guards the hand-written migration
 * against drift; the table/column shapes asserted here are the CONTRACT
 * consumed by server/services/manufacturerPrograms.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0059_manufacturer_credit_programs.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0059_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0058_snapshot.json"), "utf8"));

describe("0059_manufacturer_credit_programs.sql", () => {
  it("creates manufacturer_credit_programs with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "manufacturer_credit_programs"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"name" varchar(255) NOT NULL',
      '"status" varchar(20) DEFAULT \'draft\' NOT NULL',
      '"max_exposure_cents" bigint NOT NULL',
      '"program_cap_cents" bigint NOT NULL',
      '"concentration_cap_bps" integer DEFAULT 10000 NOT NULL',
      '"allowed_tenor_days" jsonb DEFAULT \'[]\'::jsonb NOT NULL',
      '"fee_bps" integer DEFAULT 0 NOT NULL',
      '"scoring_weights" jsonb',
      '"created_at" timestamp DEFAULT now() NOT NULL',
      '"updated_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("adds credit_accounts.program_id and the supporting indexes", () => {
    expect(sql).toContain('ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "program_id" varchar(36)');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "manufacturer_credit_programs_tenant_name_uniq"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "credit_accounts_program_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0058 and registers journal idx 59", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0059_manufacturer_credit_programs");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(59);
  });

  it("snapshot carries the new table and the program_id column", () => {
    const t = snapshot.tables["public.manufacturer_credit_programs"];
    expect(t).toBeTruthy();
    for (const c of [
      "id", "tenant_id", "name", "status", "max_exposure_cents", "program_cap_cents",
      "concentration_cap_bps", "allowed_tenor_days", "fee_bps", "scoring_weights",
      "created_at", "updated_at",
    ]) expect(t.columns[c], `column ${c}`).toBeTruthy();
    expect(t.indexes["manufacturer_credit_programs_tenant_name_uniq"].isUnique).toBe(true);
    expect(snapshot.tables["public.credit_accounts"].columns.program_id.type).toBe("varchar(36)");
  });
});
