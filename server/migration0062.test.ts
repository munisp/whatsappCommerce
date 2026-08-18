/**
 * W20 migration shape — drizzle/0062_anomaly_alerts.sql + journal idx 62 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/auditAnomaly.ts. NOTE: this migration is chained from
 * 0061's snapshot (0061 and 0062 were parallel wave branches; the merge
 * orchestrator re-chains).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0062_anomaly_alerts.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0062_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0061_snapshot.json"), "utf8"));

describe("0062_anomaly_alerts.sql", () => {
  it("creates anomaly_alerts with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "anomaly_alerts"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"signal" varchar(100) NOT NULL',
      '"score" double precision NOT NULL',
      '"detail_jsonb" jsonb',
      '"status" varchar(20) DEFAULT \'open\' NOT NULL',
      '"window_bucket" timestamp NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("creates the idempotency unique index on (tenant_id, signal, window_bucket)", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "anomaly_alerts_tenant_signal_bucket_uniq"');
    expect(sql).toContain('("tenant_id","signal","window_bucket")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "anomaly_alerts_tenant_status_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0061 and registers journal idx 62", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0062_anomaly_alerts");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(62);
    expect(entry.when).toBe(1786988600000);
    // Later waves (0063+) append after 0062 — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(62);
    expect(journal.entries.filter((e: any) => e.idx === 62)).toHaveLength(1);
  });

  it("snapshot carries anomaly_alerts and stays cumulative", () => {
    const t = snapshot.tables["public.anomaly_alerts"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "signal", "score", "detail_jsonb", "status", "window_bucket", "created_at"]) {
      expect(t.columns[c], `anomaly_alerts.${c}`).toBeTruthy();
    }
    expect(t.indexes["anomaly_alerts_tenant_signal_bucket_uniq"].isUnique).toBe(true);
    // cumulative: every 0061 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
  });
});
