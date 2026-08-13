/**
 * W14.1 migration shape — drizzle/0052_repayment_ref_unique.sql + journal
 * idx 52 + snapshot consistency. Guards the hand-written partial unique
 * index (exactly-once repayment per account+ref) against drift from
 * drizzle/schema.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0052_repayment_ref_unique.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0052_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0051_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0052_repayment_ref_unique.sql", () => {
  it("creates a partial UNIQUE index over (credit_account_id, ref) for repayment rows only", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_repayment_ref_uniq" ON "credit_ledger" USING btree ("credit_account_id","ref")',
    );
    // Scoped: settlement_retry markers share the table (kind='adjustment')
    // with the SAME ref — the predicate must exclude them and NULL refs.
    expect(sql).toContain("WHERE kind = 'repayment' AND ref IS NOT NULL");
  });
});

describe("drizzle meta (idx 52)", () => {
  it("journal has the 0052 entry chained after 0051", () => {
    const e51 = journal.entries.find((e: any) => e.idx === 51);
    const e52 = journal.entries.find((e: any) => e.idx === 52);
    expect(e51?.tag).toBe("0051_bureau_facilities");
    expect(e52?.tag).toBe("0052_repayment_ref_unique");
    expect(e52.when).toBeGreaterThan(e51.when);
    expect(journal.entries[journal.entries.length - 1].idx).toBe(52);
  });

  it("snapshot 0052 prevId chains to snapshot 0051 id", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries the partial unique index on credit_ledger", () => {
    const idx = snapshot.tables["public.credit_ledger"].indexes.credit_ledger_repayment_ref_uniq;
    expect(idx).toBeDefined();
    expect(idx.isUnique).toBe(true);
    expect(idx.columns.map((c: any) => c.expression)).toEqual(["credit_account_id", "ref"]);
    expect(idx.where).toBe("kind = 'repayment' AND ref IS NOT NULL");
  });
});

describe("schema.ts alignment", () => {
  it("creditLedger declares the partial unique index", () => {
    expect(schemaTs).toContain('uniqueIndex("credit_ledger_repayment_ref_uniq")');
    expect(schemaTs).toContain("kind = 'repayment' AND ref IS NOT NULL");
  });
});
