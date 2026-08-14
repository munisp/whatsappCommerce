/**
 * R2 migration shape — drizzle/0053_funds_flow_integrity.sql + journal
 * idx 53 + snapshot consistency. Guards the hand-written migration against
 * drift from drizzle/schema.ts (drizzle-kit generate is unavailable; the
 * snapshot/journal are maintained by hand per the 0051/0052 pattern).
 *
 * 0053 is additive-only and idempotent (IF NOT EXISTS):
 *   - credit_ledger_draw_ref_uniq   (A1-04/F-01: exactly-once invoice draw)
 *   - wallet_tx_wallet_ref_uniq     (A1-03: exactly-once withdrawal per ref)
 *   - mandate_charges table         (A1-02/F-03: durable pending charges)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0053_funds_flow_integrity.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0053_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0052_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0053_funds_flow_integrity.sql", () => {
  it("creates the invoice-draw exactly-once partial unique index (A1-04)", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_draw_ref_uniq" ON "credit_ledger" USING btree ("credit_account_id","ref") WHERE kind = \'invoice_draw\' AND ref IS NOT NULL',
    );
  });

  it("creates the withdrawal idempotency partial unique index (A1-03)", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "wallet_tx_wallet_ref_uniq" ON "wallet_transactions" USING btree ("wallet_id","reference") WHERE reference IS NOT NULL',
    );
  });

  it("creates mandate_charges with the contract columns (A1-02)", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "mandate_charges"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"account_id" uuid NOT NULL',
      '"mandate_id" uuid',
      '"mandate_ref" varchar(128)',
      '"provider" varchar(30) NOT NULL',
      '"reference" varchar(128) NOT NULL',
      '"amount_cents" bigint NOT NULL',
      '"currency" varchar(3) DEFAULT \'NGN\' NOT NULL',
      '"status" varchar(20) DEFAULT \'pending\' NOT NULL',
      '"provider_status" varchar(40)',
      '"raw_response" jsonb',
      '"created_at" timestamp DEFAULT now() NOT NULL',
      '"updated_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "mandate_charges_reference_uniq" ON "mandate_charges" USING btree ("reference")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "mandate_charges_account_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "mandate_charges_status_idx"');
  });

  it("is registered as journal idx 53 chaining from the 0052 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0053_funds_flow_integrity");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(53);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
  });

  it("snapshot carries the new indexes and the mandate_charges table", () => {
    const cl = snapshot.tables["public.credit_ledger"];
    expect(cl.indexes["credit_ledger_draw_ref_uniq"].isUnique).toBe(true);
    expect(cl.indexes["credit_ledger_draw_ref_uniq"].where).toBe("kind = 'invoice_draw' AND ref IS NOT NULL");
    // 0052's repayment index is preserved.
    expect(cl.indexes["credit_ledger_repayment_ref_uniq"].where).toBe("kind = 'repayment' AND ref IS NOT NULL");
    const wt = snapshot.tables["public.wallet_transactions"];
    expect(wt.indexes["wallet_tx_wallet_ref_uniq"].isUnique).toBe(true);
    expect(wt.indexes["wallet_tx_wallet_ref_uniq"].where).toBe("reference IS NOT NULL");
    const mc = snapshot.tables["public.mandate_charges"];
    expect(mc).toBeDefined();
    expect(mc.columns["amount_cents"].type).toBe("bigint");
    expect(mc.indexes["mandate_charges_reference_uniq"].isUnique).toBe(true);
  });

  it("schema.ts matches the migration (drift guard)", () => {
    expect(schemaTs).toContain('uniqueIndex("credit_ledger_draw_ref_uniq")');
    expect(schemaTs).toContain('uniqueIndex("wallet_tx_wallet_ref_uniq")');
    expect(schemaTs).toContain('pgTable("mandate_charges"');
    expect(schemaTs).toContain('uniqueIndex("mandate_charges_reference_uniq")');
  });
});
