/**
 * W18 migration shape — drizzle/0058_credit_terms_fee_bps.sql + journal
 * idx 58 + snapshot consistency (drizzle-kit generate is unavailable; the
 * snapshot/journal are maintained by hand per the 0051–0057 pattern).
 *
 * 0058 is additive-only and idempotent (IF NOT EXISTS): fee_bps on
 * credit_accounts snapshots the risk-based facility fee (terms.ts) at
 * approval. NULL for pre-W18 facilities (downward-compatible: no fee).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0058_credit_terms_fee_bps.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0058_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0057_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0058_credit_terms_fee_bps.sql", () => {
  it("adds fee_bps to credit_accounts additively and idempotently", () => {
    expect(sql).toContain('ALTER TABLE "credit_accounts" ADD COLUMN IF NOT EXISTS "fee_bps" integer');
    expect(sql).not.toMatch(/DROP/i);
  });

  it("is registered as journal idx 58 chaining from the 0057 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0058_credit_terms_fee_bps");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(58);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
  });

  it("snapshot carries fee_bps on credit_accounts, matching schema.ts", () => {
    const col = snapshot.tables["public.credit_accounts"].columns["fee_bps"];
    expect(col).toMatchObject({ name: "fee_bps", type: "integer", notNull: false });
    expect(schemaTs).toContain('feeBps: integer("fee_bps")');
  });
});
