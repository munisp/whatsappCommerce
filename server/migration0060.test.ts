/**
 * W19 migration shape — drizzle/0060_soc2_compliance.sql + journal idx 60 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shapes asserted here are the CONTRACT consumed by
 * server/services/auditChain.ts and server/services/retention.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0060_soc2_compliance.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0060_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0059_snapshot.json"), "utf8"));

describe("0060_soc2_compliance.sql", () => {
  it("creates audit_chain with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "audit_chain"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36)',
      '"event_type" varchar(100) NOT NULL',
      '"actor_id" varchar(64)',
      '"payload_jsonb" jsonb',
      '"prev_hash" varchar(64) NOT NULL',
      '"hash" varchar(64) NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("creates retention_policies with legal hold and the tenant/entity unique index", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "retention_policies"');
    for (const frag of [
      '"tenant_id" varchar(36) NOT NULL',
      '"entity" varchar(64) NOT NULL',
      '"retention_days" integer NOT NULL',
      '"legal_hold" boolean DEFAULT false NOT NULL',
      '"updated_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "retention_policies_tenant_entity_uniq"');
  });

  it("creates incidents with the status-machine columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "incidents"');
    for (const frag of [
      '"severity" varchar(20) DEFAULT \'low\' NOT NULL',
      '"status" varchar(20) DEFAULT \'open\' NOT NULL',
      '"title" varchar(255) NOT NULL',
      '"opened_at" timestamp DEFAULT now() NOT NULL',
      '"resolved_at" timestamp',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "incidents_tenant_status_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0059 and registers journal idx 60", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0060_soc2_compliance");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(60);
    expect(journal.entries[journal.entries.length - 1].idx).toBe(60);
  });

  it("snapshot carries the new tables and stays cumulative", () => {
    for (const t of ["public.audit_chain", "public.retention_policies", "public.incidents"]) {
      expect(snapshot.tables[t], t).toBeTruthy();
    }
    const ac = snapshot.tables["public.audit_chain"];
    for (const c of ["id", "tenant_id", "event_type", "actor_id", "payload_jsonb", "prev_hash", "hash", "created_at"]) {
      expect(ac.columns[c], `audit_chain.${c}`).toBeTruthy();
    }
    expect(snapshot.tables["public.retention_policies"].indexes["retention_policies_tenant_entity_uniq"].isUnique).toBe(true);
    // cumulative: every 0059 table still present
    for (const t of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[t], `missing prior table ${t}`).toBeTruthy();
    }
  });
});
