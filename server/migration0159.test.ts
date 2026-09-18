/**
 * === W46 orders-p2 (Coder G) ===
 * Migration shape guard for drizzle/0159_w46_orders_p2.sql + journal idx 159
 * chained from the 0151 tip + cumulative snapshot (full column union).
 * The shapes asserted here are the CONTRACT consumed by
 * server/services/procurement/poBreach.ts (ORD-19) and
 * server/services/recalls.ts (ORD-22).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql159 = readFileSync(join(DRIZZLE, "0159_w46_orders_p2.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap159 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0159_w46_orders_p2_snapshot.json"), "utf8"));
const snap151 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0151_payment_outbox_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0159_w46_orders_p2.sql", () => {
  it("adds the ORD-19 promised-date columns to purchase_orders", () => {
    expect(sql159).toContain('ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "approved_at" timestamp');
    expect(sql159).toContain('ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "promised_date" timestamp');
    expect(sql159).toContain('ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "breach_alerted_at" timestamp');
    expect(sql159).toContain('CREATE INDEX IF NOT EXISTS "purchase_orders_promised_idx"');
  });

  it("creates the ORD-22 recall tables with exactly-once recipient uniqueness", () => {
    expect(sql159).toContain('CREATE TABLE IF NOT EXISTS "product_recalls"');
    expect(sql159).toContain('CREATE TABLE IF NOT EXISTS "recall_recipients"');
    expect(sql159).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "recall_recipients_recall_order_uniq" ON "recall_recipients" USING btree ("recall_id","order_id")');
    expect(sql159).toContain(`"status" varchar(20) DEFAULT 'pending' NOT NULL`);
  });

  it("is additive only (no drops, no renames)", () => {
    expect(sql159).not.toMatch(/DROP\s/i);
    expect(sql159).not.toMatch(/RENAME/i);
  });

  it("journal chains idx 159 from the 0158 predecessor (merge re-chained 0151→0152..0162)", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0159_w46_orders_p2");
    expect(entry?.idx).toBe(159);
    const snap158 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0158_w46_warehouse_backfill_snapshot.json"), "utf8"));
    expect(snap159.prevId).toBe(snap158.id);
    // …and the whole sub-chain still hangs off the 0151 tip.
    const snap152 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0152_w46_auctions_tips_donations_snapshot.json"), "utf8"));
    expect(snap152.prevId).toBe(snap151.id);
  });

  it("snapshot is cumulative (full column union of the 0151 tip)", () => {
    for (const [table, def] of Object.entries(snap151.tables) as [string, any][]) {
      const t = snap159.tables[table];
      expect(t, `missing table ${table}`).toBeTruthy();
      for (const col of Object.keys(def.columns)) {
        expect(t.columns[col], `${table}.${col}`).toBeTruthy();
      }
    }
    // New shapes present in the snapshot.
    const po = snap159.tables["public.purchase_orders"];
    expect(po.columns.approved_at).toBeTruthy();
    expect(po.columns.promised_date).toBeTruthy();
    expect(po.columns.breach_alerted_at).toBeTruthy();
    expect(snap159.tables["public.product_recalls"]).toBeTruthy();
    expect(snap159.tables["public.recall_recipients"].indexes.recall_recipients_recall_order_uniq.isUnique).toBe(true);
  });

  it("schema.ts declares the same shapes", () => {
    expect(schemaTs).toContain('timestamp("promised_date")');
    expect(schemaTs).toContain('timestamp("breach_alerted_at")');
    expect(schemaTs).toContain('pgTable("product_recalls"');
    expect(schemaTs).toContain('pgTable("recall_recipients"');
  });
});
