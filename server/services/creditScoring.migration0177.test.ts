// === W56 credit ===
/**
 * W56 migration shape — drizzle/0177_w56_credit.sql + journal idx 177 +
 * snapshot consistency (drizzle-kit generate is unavailable; the
 * snapshot/journal are maintained by hand per the 0051–0176 pattern).
 *
 * 0177 is additive-only and idempotent (IF NOT EXISTS): credit_scores,
 * bureau_consents, bureau_pulls, bureau_report_outbox.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0177_w56_credit.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0177_w56_credit_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0176_w54_membership_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0177_w56_credit.sql", () => {
  it("creates the four W56 tables additively and idempotently", () => {
    for (const t of ["credit_scores", "bureau_consents", "bureau_pulls", "bureau_report_outbox"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    }
    expect(sql).not.toMatch(/DROP/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
  });

  it("is registered as journal idx 177 chaining from the 0176 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0177_w56_credit");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(177);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
  });

  it("snapshot is a FULL union: all 0176 tables retained + 4 new", () => {
    expect(Object.keys(snapshot.tables).length).toBe(Object.keys(prevSnapshot.tables).length + 4);
    for (const k of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[k]).toBeDefined();
    }
  });

  it("snapshot tables match schema.ts declarations", () => {
    const cs = snapshot.tables["public.credit_scores"];
    expect(cs.columns.score).toMatchObject({ name: "score", type: "integer", notNull: true });
    expect(cs.columns.grade).toMatchObject({ name: "grade", type: "varchar(1)", notNull: true });
    expect(cs.columns.version.default).toBe("'w56-v1'");
    expect(schemaTs).toContain('pgTable("credit_scores"');
    expect(schemaTs).toContain('pgTable("bureau_consents"');
    expect(schemaTs).toContain('pgTable("bureau_pulls"');
    expect(schemaTs).toContain('pgTable("bureau_report_outbox"');
    const ob = snapshot.tables["public.bureau_report_outbox"];
    expect(ob.indexes.bureau_report_outbox_key_uniq.isUnique).toBe(true);
  });
});
