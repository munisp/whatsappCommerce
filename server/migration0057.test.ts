/**
 * W17 F11 migration shape — drizzle/0057_customer_lead_scores.sql + journal
 * idx 57 + snapshot consistency (same hand-written pattern as 0051–0054;
 * drizzle-kit generate is unavailable).
 *
 * 0057 is additive-only and idempotent (IF NOT EXISTS):
 *   - customer_lead_scores table (tenantId+customerId unique, score/band/
 *     stage/factors jsonb/computedAt) backing server/services/leadScoring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0057_customer_lead_scores.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0057_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0056_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0057_customer_lead_scores.sql", () => {
  it("creates the table additively + idempotently", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "customer_lead_scores"');
    expect(sql).toContain('"factors" jsonb');
    expect(sql).toContain("customer_lead_scores_tenant_customer_uniq");
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("ALTER TABLE \"customers\"");
  });

  it("is registered as journal idx 57 chaining from the 0056 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0057_customer_lead_scores");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(57);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries the table and preserves 0056's tables", () => {
    const t = snapshot.tables["public.customer_lead_scores"];
    expect(t).toBeDefined();
    expect(t.columns["score"].type).toBe("integer");
    expect(t.columns["band"].type).toBe("varchar(10)");
    expect(t.columns["factors"].type).toBe("jsonb");
    expect(t.indexes["customer_lead_scores_tenant_customer_uniq"].isUnique).toBe(true);
    expect(snapshot.tables["public.visual_inventory_sessions"]).toBeDefined();
  });

  it("schema.ts matches the migration (drift guard)", () => {
    expect(schemaTs).toContain('pgTable("customer_lead_scores"');
    expect(schemaTs).toContain('uniqueIndex("customer_lead_scores_tenant_customer_uniq")');
  });
});
