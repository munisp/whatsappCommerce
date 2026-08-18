/**
 * W22 migration shape — drizzle/0066_bandit_decisions.sql + journal idx 66 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/banditLimits.ts (banditSuggest inserts, the reward tick
 * and replay read). NOTE: this migration is chained from 0064's snapshot
 * (0065 is a parallel wave branch; the merge orchestrator re-chains).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0066_bandit_decisions.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0066_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0065_snapshot.json"), "utf8"));

describe("0066_bandit_decisions.sql", () => {
  it("creates bandit_decisions with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "bandit_decisions"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"buyer_id" varchar(36) NOT NULL',
      '"context_jsonb" jsonb NOT NULL',
      '"chosen_multiplier" real NOT NULL',
      '"suggested_limit_cents" bigint NOT NULL',
      '"baseline_limit_cents" bigint NOT NULL',
      '"mode" varchar(16) DEFAULT \'shadow\' NOT NULL',
      '"reward" real',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("indexes by tenant and by reward (reward-tick sweep)", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "bandit_decisions_tenant_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "bandit_decisions_reward_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0065 and registers journal idx 66", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0066_bandit_decisions");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(66);
    expect(entry.when).toBe(1786989000000);
    // Parallel branches (0065+) and later waves append — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(66);
    expect(journal.entries.filter((e: any) => e.idx === 66)).toHaveLength(1);
  });

  it("snapshot carries bandit_decisions and stays cumulative", () => {
    const t = snapshot.tables["public.bandit_decisions"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "buyer_id", "context_jsonb", "chosen_multiplier", "suggested_limit_cents", "baseline_limit_cents", "mode", "reward", "created_at"]) {
      expect(t.columns[c], `bandit_decisions.${c}`).toBeTruthy();
    }
    expect(t.indexes["bandit_decisions_tenant_idx"]).toBeTruthy();
    expect(t.indexes["bandit_decisions_reward_idx"]).toBeTruthy();
    // cumulative: every 0065 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
    // enums carried over unchanged (no new enums in 0066)
    expect(Object.keys(snapshot.enums)).toEqual(Object.keys(prevSnapshot.enums));
  });
});
