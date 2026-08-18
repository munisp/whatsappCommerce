/**
 * W22 migration shape — drizzle/0065_graph_alerts.sql + journal idx 65 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shape asserted here is the CONTRACT consumed by
 * server/services/graphCollusion.ts (scanGraphCollusionTx inserts, the
 * compliance router reads/updates).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0065_graph_alerts.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0065_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0064_snapshot.json"), "utf8"));

describe("0065_graph_alerts.sql", () => {
  it("creates graph_alerts with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "graph_alerts"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"buyer_id" varchar(36) NOT NULL',
      '"signal" varchar(100) NOT NULL',
      '"score" double precision NOT NULL',
      '"evidence_jsonb" jsonb',
      '"status" varchar(20) DEFAULT \'open\' NOT NULL',
      '"window_bucket" timestamp NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("indexes by tenant/buyer and enforces idempotency per (tenant, buyer, signal, bucket)", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "graph_alerts_tenant_buyer_signal_bucket_uniq"');
    expect(sql).toContain('("tenant_id","buyer_id","signal","window_bucket")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "graph_alerts_tenant_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "graph_alerts_tenant_status_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "graph_alerts_buyer_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0064 and registers journal idx 65", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0065_graph_alerts");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(65);
    expect(entry.when).toBe(1786988900000);
    // Later waves append after 0065 — the tip only moves forward.
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(65);
    expect(journal.entries.filter((e: any) => e.idx === 65)).toHaveLength(1);
  });

  it("snapshot carries graph_alerts and stays cumulative", () => {
    const t = snapshot.tables["public.graph_alerts"];
    expect(t).toBeTruthy();
    for (const c of ["id", "tenant_id", "buyer_id", "signal", "score", "evidence_jsonb", "status", "window_bucket", "created_at"]) {
      expect(t.columns[c], `graph_alerts.${c}`).toBeTruthy();
    }
    expect(t.indexes["graph_alerts_tenant_buyer_signal_bucket_uniq"].isUnique).toBe(true);
    // cumulative: every 0064 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
    // enums carried over unchanged (no new enums in 0065)
    expect(Object.keys(snapshot.enums)).toEqual(Object.keys(prevSnapshot.enums));
  });
});
