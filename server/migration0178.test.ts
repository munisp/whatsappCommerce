// === W57 risk-shield ===
/**
 * W57 migration shape — drizzle/0178_w57_risk_shield.sql + journal idx 178 +
 * snapshot chained from 0177 (W56 credit), cumulative union. Guards the
 * hand-written migration against drift; the table shapes asserted here are
 * the CONTRACTS consumed by services/identityGraph.ts (identity_links,
 * identity_flags), services/creditDefaultRegistry.ts
 * (credit_default_registry), services/creditInsurance.ts
 * (credit_insurance_policies/claims) and services/provisionFund.ts
 * (provision_fund_ledger + escrow_config.provision_fund_bps).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0178_w57_risk_shield.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0178_w57_risk_shield_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0177_w56_credit_snapshot.json"), "utf8"));

describe("0178_w57_risk_shield.sql", () => {
  it("creates the identity graph tables with hashed-link contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "identity_links"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "identity_flags"');
    for (const frag of [
      '"subjectType" varchar(8) NOT NULL',
      '"linkType" varchar(16) NOT NULL',
      '"linkHash" varchar(64) NOT NULL',
      '"status" varchar(16) DEFAULT \'active\' NOT NULL',
    ]) expect(sql).toContain(frag);
    // Raw BVN/NIN are NEVER columns — hashes only.
    expect(sql.toLowerCase()).not.toMatch(/"bvn"\s+varchar/);
    expect(sql.toLowerCase()).not.toMatch(/"nin"\s+varchar/);
  });

  it("creates the default registry / insurance / provision tables", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credit_default_registry"');
    expect(sql).toContain('"amountCents" integer NOT NULL');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credit_insurance_policies"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "credit_insurance_claims"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "provision_fund_ledger"');
    expect(sql).toContain('"tenantId" varchar(36),\n\t"kind" varchar(16) NOT NULL'); // nullable platform-level tenantId
  });

  it("idempotency indexes: unique refs/keys on every money or identity row", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_subject_link_uniq"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "credit_default_registry_account_uniq"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "credit_insurance_policies_key_uniq"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "credit_insurance_claims_key_uniq"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "provision_fund_ledger_ref_uniq"');
  });

  it("adds the provision-fund bps config to escrow_config (additive ALTER)", () => {
    expect(sql).toContain('ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "provision_fund_bps" integer DEFAULT 250 NOT NULL');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0177 (W56 credit) and registers journal idx 178", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0178_w57_risk_shield");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(178);
    expect(journal.entries.filter((e: any) => e.idx === 178)).toHaveLength(1);
    // FULL snapshot union: everything in 0177 carries over, plus W57 tables.
    for (const t of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[t], `union carries ${t}`).toBeTruthy();
    }
    for (const t of [
      "public.identity_links",
      "public.identity_flags",
      "public.credit_default_registry",
      "public.credit_insurance_policies",
      "public.credit_insurance_claims",
      "public.provision_fund_ledger",
    ]) expect(snapshot.tables[t], `snapshot has ${t}`).toBeTruthy();
    expect(snapshot.tables["public.escrow_config"].columns["provision_fund_bps"]).toBeTruthy();
  });
});
