/**
 * CV-1 migration shape — drizzle/0054_visual_stocktake_source.sql + journal
 * idx 54 + snapshot consistency. Guards the hand-written migration against
 * drift from drizzle/schema.ts (drizzle-kit generate is unavailable; the
 * snapshot/journal are maintained by hand per the 0051/0052/0053 pattern).
 *
 * 0054 is additive-only and idempotent (IF NOT EXISTS):
 *   - visual_inventory_sessions.source varchar(32) DEFAULT 'mobile' NOT NULL
 *     (J85 WhatsApp stock-take capture channel)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0054_visual_stocktake_source.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0054_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0053_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0054_visual_stocktake_source.sql", () => {
  it("adds the source column additively + idempotently", () => {
    expect(sql).toContain(
      'ALTER TABLE "visual_inventory_sessions" ADD COLUMN IF NOT EXISTS "source" varchar(32) DEFAULT \'mobile\' NOT NULL',
    );
    expect(sql).not.toContain("DROP");
  });

  it("is registered as journal idx 54 chaining from the 0053 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0054_visual_stocktake_source");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(54);
    // Last journal entry (no later migration may precede it).
    expect(journal.entries[journal.entries.length - 1].tag).toBe("0054_visual_stocktake_source");
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries the source column and preserves 0053's tables", () => {
    const vis = snapshot.tables["public.visual_inventory_sessions"];
    expect(vis).toBeDefined();
    expect(vis.columns["source"]).toMatchObject({
      name: "source",
      type: "varchar(32)",
      notNull: true,
      default: "'mobile'",
    });
    // Existing columns preserved.
    expect(vis.columns["scanLocation"].type).toBe("varchar(256)");
    expect(vis.columns["status"].type).toBe("visual_inventory_status");
    // 0053's mandate_charges table is preserved.
    expect(snapshot.tables["public.mandate_charges"]).toBeDefined();
  });

  it("schema.ts matches the migration (drift guard)", () => {
    expect(schemaTs).toContain('source: varchar("source", { length: 32 }).default("mobile").notNull()');
    expect(schemaTs).toContain('pgTable("visual_inventory_sessions"');
  });
});
