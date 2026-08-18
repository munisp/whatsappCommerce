/**
 * W21 migration shape — drizzle/0063_credit_pd_models.sql + journal idx 63 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/tradeCredit/mlPdScoring.ts (trainPdModelTx inserts,
 * loadLatestPdModel reads — tenant_id nullable for the global corpus model).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0063_credit_pd_models.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0063_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0062_snapshot.json"), "utf8"));

describe("0063_credit_pd_models.sql", () => {
  it("creates credit_pd_models with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credit_pd_models"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36)',
      '"weights_jsonb" jsonb NOT NULL',
      '"feature_names" jsonb NOT NULL',
      '"trained_at" timestamp DEFAULT now() NOT NULL',
      '"sample_count" integer NOT NULL',
      '"logloss" real',
      '"auc" real',
      '"version" integer DEFAULT 1 NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("tenant_id is nullable (global corpus model) and indexed per (tenant, version)", () => {
    expect(sql).not.toMatch(/"tenant_id" varchar\(36\) NOT NULL/);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "credit_pd_models_tenant_idx"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "credit_pd_models_tenant_version_uniq"');
    expect(sql).toContain('("tenant_id","version")');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0062 and registers journal idx 63", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0063_credit_pd_models");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(63);
    expect(entry.when).toBe(1786988700000);
    // Later waves (0064+) append after 0063 — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(63);
    expect(journal.entries.filter((e: any) => e.idx === 63)).toHaveLength(1);
  });

  it("snapshot carries credit_pd_models and stays cumulative", () => {
    const t = snapshot.tables["public.credit_pd_models"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "weights_jsonb", "feature_names", "trained_at", "sample_count", "logloss", "auc", "version", "created_at"]) {
      expect(t.columns[c], `credit_pd_models.${c}`).toBeTruthy();
    }
    expect(t.columns["tenant_id"].notNull).toBe(false);
    expect(t.indexes["credit_pd_models_tenant_version_uniq"].isUnique).toBe(true);
    // cumulative: every 0062 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
  });
});
