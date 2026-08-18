/**
 * W21 migration shape — drizzle/0064_uplift_models.sql + journal idx 64 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/mlUplift.ts (trainUpliftModelsTx inserts, loadLatestModels
 * reads). NOTE: this migration is chained from 0062's snapshot (0063 was a
 * parallel wave branch; the merge orchestrator re-chains).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0064_uplift_models.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0064_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0063_snapshot.json"), "utf8"));

describe("0064_uplift_models.sql", () => {
  it("creates uplift_models with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "uplift_models"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"role" varchar(16) NOT NULL',
      '"weights_jsonb" jsonb NOT NULL',
      '"feature_names" jsonb NOT NULL',
      '"trained_at" timestamp DEFAULT now() NOT NULL',
      '"sample_count" integer NOT NULL',
      '"logloss" real',
      '"version" integer DEFAULT 1 NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("indexes by tenant and enforces one row per (tenant, role, version)", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "uplift_models_tenant_idx"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uplift_models_tenant_role_version_uniq"');
    expect(sql).toContain('("tenant_id","role","version")');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0063 and registers journal idx 64", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0064_uplift_models");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(64);
    expect(entry.when).toBe(1786988800000);
    // Parallel branches (0063+) and later waves append — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(64);
    expect(journal.entries.filter((e: any) => e.idx === 64)).toHaveLength(1);
  });

  it("snapshot carries uplift_models and stays cumulative", () => {
    const t = snapshot.tables["public.uplift_models"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "role", "weights_jsonb", "feature_names", "trained_at", "sample_count", "logloss", "version", "created_at"]) {
      expect(t.columns[c], `uplift_models.${c}`).toBeTruthy();
    }
    expect(t.indexes["uplift_models_tenant_role_version_uniq"].isUnique).toBe(true);
    // cumulative: every 0063 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
    // enums carried over unchanged (no new enums in 0064)
    expect(Object.keys(snapshot.enums)).toEqual(Object.keys(prevSnapshot.enums));
  });
});
