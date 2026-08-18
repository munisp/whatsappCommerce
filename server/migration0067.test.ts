/**
 * W22 migration shape — drizzle/0067_copilot_queries.sql + journal idx 67 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/llmCopilot.ts (logCopilotQuery inserts, copilot.history
 * reads). NOTE: this migration is chained from 0064's snapshot (0065/0066
 * are parallel wave branches; the merge orchestrator re-chains).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0067_copilot_queries.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0067_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0066_snapshot.json"), "utf8"));

describe("0067_copilot_queries.sql", () => {
  it("creates copilot_queries with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "copilot_queries"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"kind" varchar(10) NOT NULL',
      '"prompt_hash" varchar(64) NOT NULL',
      '"fallback_used" boolean DEFAULT false NOT NULL',
      '"latency_ms" integer DEFAULT 0 NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("indexes by tenant and (tenant, created_at)", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "copilot_queries_tenant_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "copilot_queries_tenant_created_idx"');
    expect(sql).toContain('("tenant_id","created_at")');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0066 and registers journal idx 67", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0067_copilot_queries");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(67);
    expect(entry.when).toBe(1786989100000);
    // Parallel branches (0065/0066) and later waves append — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(67);
    expect(journal.entries.filter((e: any) => e.idx === 67)).toHaveLength(1);
  });

  it("snapshot carries copilot_queries and stays cumulative", () => {
    const t = snapshot.tables["public.copilot_queries"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "kind", "prompt_hash", "fallback_used", "latency_ms", "created_at"]) {
      expect(t.columns[c], `copilot_queries.${c}`).toBeTruthy();
    }
    expect(t.indexes["copilot_queries_tenant_idx"]).toBeTruthy();
    expect(t.indexes["copilot_queries_tenant_created_idx"]).toBeTruthy();
    // cumulative: every 0066 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
    // enums carried over unchanged (no new enums in 0067)
    expect(Object.keys(snapshot.enums)).toEqual(Object.keys(prevSnapshot.enums));
  });
});
