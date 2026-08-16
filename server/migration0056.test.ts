/**
 * W17/F10 migration shape — drizzle/0056_cod_offline_flow.sql + journal idx 56
 * + snapshot consistency (drizzle-kit generate is unavailable; the
 * snapshot/journal are maintained by hand per the 0051–0054 pattern).
 *
 * 0056 is additive-only and idempotent (IF NOT EXISTS / ADD VALUE IF NOT
 * EXISTS):
 *   - orders.codState varchar(32) NULL (COD state machine)
 *   - cod_events append-only audit table + claim-first partial unique indexes
 *   - payment_transactions COD providerRef unique claim
 *   - notification_type += cod_discrepancy | cod_delivery_failed
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0056_cod_offline_flow.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0056_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0055_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0056_cod_offline_flow.sql", () => {
  it("is additive-only (no destructive statements)", () => {
    expect(sql).not.toContain("DROP");
    expect(sql).not.toMatch(/ALTER TABLE .* DROP/i);
    expect(sql).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codState" varchar(32)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "cod_events"');
  });

  it("enforces funds-critical idempotency claims via partial unique indexes", () => {
    expect(sql).toContain('"cod_events_collected_uq"');
    expect(sql).toContain('"cod_events_settled_uq"');
    expect(sql).toContain('"ptx_cod_ref_uq"');
    expect(sql).toContain("WHERE \"toState\" = 'settled'");
  });

  it("adds the COD notification types additively", () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'cod_discrepancy'");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'cod_delivery_failed'");
  });

  it("is registered as journal idx 56 chaining from the 0055 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0056_cod_offline_flow");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(56);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries codState, cod_events and preserves 0055's tables", () => {
    const o = snapshot.tables["public.orders"];
    expect(o.columns["codState"]).toMatchObject({ name: "codState", type: "varchar(32)", notNull: false });
    expect(o.indexes["orders_cod_state_idx"]).toBeDefined();
    const ce = snapshot.tables["public.cod_events"];
    expect(ce).toBeDefined();
    for (const c of ["id", "tenantId", "orderId", "fromState", "toState", "actor", "note", "createdAt"]) {
      expect(ce.columns[c], `cod_events.${c}`).toBeDefined();
    }
    expect(snapshot.tables["public.payment_transactions"].indexes["ptx_cod_ref_uq"].isUnique).toBe(true);
    expect(snapshot.enums["public.notification_type"].values).toContain("cod_discrepancy");
    // 0054's tables preserved.
    expect(snapshot.tables["public.visual_inventory_sessions"]).toBeDefined();
    expect(snapshot.tables["public.mandate_charges"]).toBeDefined();
  });

  it("schema.ts matches the migration (drift guard)", () => {
    expect(schemaTs).toContain('codState: varchar("codState", { length: 32 })');
    expect(schemaTs).toContain('pgTable("cod_events"');
    expect(schemaTs).toContain('"cod_discrepancy"');
    expect(schemaTs).toContain('"cod_delivery_failed"');
  });
});
