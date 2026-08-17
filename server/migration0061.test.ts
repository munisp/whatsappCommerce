/**
 * W20 migration shape — drizzle/0061_lead_score_models.sql + journal idx 61 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/mlLeadScoring.ts (trainLeadModelTx inserts, loadLatestModel
 * reads).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0061_lead_score_models.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0061_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0060_snapshot.json"), "utf8"));

describe("0061_lead_score_models.sql", () => {
  it("creates lead_score_models with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "lead_score_models"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"weights_jsonb" jsonb NOT NULL',
      '"feature_names" jsonb NOT NULL',
      '"trained_at" timestamp DEFAULT now() NOT NULL',
      '"sample_count" integer NOT NULL',
      '"logloss" real',
      '"version" integer DEFAULT 1 NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("indexes by tenant and enforces one row per (tenant, version)", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "lead_score_models_tenant_idx"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "lead_score_models_tenant_version_uniq"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0060 and registers journal idx 61", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0061_lead_score_models");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(61);
    expect(entry.when).toBe(1786988500000);
    // Later waves (0062+) append after 0061 — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(61);
    expect(journal.entries.filter((e: any) => e.idx === 61)).toHaveLength(1);
  });

  it("snapshot carries the new table and stays cumulative", () => {
    const t = snapshot.tables["public.lead_score_models"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "weights_jsonb", "feature_names", "trained_at", "sample_count", "logloss", "version", "created_at"]) {
      expect(t.columns[c], `lead_score_models.${c}`).toBeTruthy();
    }
    expect(t.indexes["lead_score_models_tenant_version_uniq"].isUnique).toBe(true);
    // cumulative: every 0060 table still present
    for (const name of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[name], `missing prior table ${name}`).toBeTruthy();
    }
    // enums carried over unchanged (no new enums in 0061)
    expect(Object.keys(snapshot.enums)).toEqual(Object.keys(prevSnapshot.enums));
  });
});
