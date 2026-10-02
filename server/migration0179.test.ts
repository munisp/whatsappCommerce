// === W59 banking-pos ===
/**
 * W59 migration shape — drizzle/0179_w59_banking_pos.sql + journal idx 179 +
 * snapshot chained from 0178 (W57 risk-shield), cumulative union. Guards the
 * hand-written migration against drift; the table shapes asserted here are
 * the CONTRACTS consumed by services/payoutAccounts.ts
 * (merchant_payout_accounts), services/agentBanking.ts
 * (agent_cico_transactions + escrow_config.agent_commission_bps /
 * agent_float_alert_threshold_cents) and services/posPayments.ts
 * (merchant_pos_terminals, pos_payment_sessions).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0179_w59_banking_pos.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0179_w59_banking_pos_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0178_w57_risk_shield_snapshot.json"), "utf8"));

describe("0179_w59_banking_pos.sql", () => {
  it("creates merchant_payout_accounts with the verified-account contract", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "merchant_payout_accounts"');
    for (const frag of [
      '"walletId" varchar(36) NOT NULL',
      '"bankCode" varchar(10) NOT NULL',
      '"accountNumber" varchar(20) NOT NULL',
      '"accountName" varchar(255) NOT NULL',
      '"provider" varchar(16) NOT NULL',
      '"isPrimary" boolean DEFAULT false NOT NULL',
      '"verifiedAt" timestamp DEFAULT now() NOT NULL',
      '"status" varchar(16) DEFAULT \'active\' NOT NULL',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "merchant_payout_accounts_wallet_provider_account_uniq"');
  });

  it("creates the agent CICO ledger with integer-cent columns + idempotency ref", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "agent_cico_transactions"');
    for (const frag of [
      '"agentTenantId" varchar(36) NOT NULL',
      '"customerPhone" varchar(32) NOT NULL',
      '"kind" varchar(16) NOT NULL',
      '"amountCents" integer NOT NULL',
      '"feeCents" integer DEFAULT 0 NOT NULL',
      '"commissionCents" integer DEFAULT 0 NOT NULL',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "agent_cico_transactions_ref_uniq"');
  });

  it("creates the POS terminal registry + payment sessions", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "merchant_pos_terminals"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pos_payment_sessions"');
    expect(sql).toContain('"amountCents" integer NOT NULL');
    expect(sql).toContain('"expiresAt" timestamp NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "merchant_pos_terminals_ref_uniq"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "pos_payment_sessions_ref_uniq"');
  });

  it("adds the agent banking config to escrow_config (additive ALTERs)", () => {
    expect(sql).toContain('ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "agent_commission_bps" integer DEFAULT 100 NOT NULL');
    expect(sql).toContain('ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "agent_float_alert_threshold_cents" integer DEFAULT 1000000 NOT NULL');
  });

  it("appends agent_cico to wallet_tx_type additively (never reorders)", () => {
    expect(sql).toContain(`ALTER TYPE "public"."wallet_tx_type" ADD VALUE IF NOT EXISTS 'agent_cico'`);
    const prevValues = prevSnapshot.enums["public.wallet_tx_type"].values;
    const nextValues = snapshot.enums["public.wallet_tx_type"].values;
    expect(nextValues.slice(0, prevValues.length)).toEqual(prevValues);
    expect(nextValues[nextValues.length - 1]).toBe("agent_cico");
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0178 (W57 risk-shield) and registers journal idx 179", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0179_w59_banking_pos");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(179);
    expect(journal.entries.filter((e: any) => e.idx === 179)).toHaveLength(1);
    // FULL snapshot union: everything in 0178 carries over, plus W59 tables.
    for (const t of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[t], `union carries ${t}`).toBeTruthy();
    }
    for (const t of [
      "public.merchant_payout_accounts",
      "public.agent_cico_transactions",
      "public.merchant_pos_terminals",
      "public.pos_payment_sessions",
    ]) expect(snapshot.tables[t], `snapshot has ${t}`).toBeTruthy();
    expect(snapshot.tables["public.escrow_config"].columns["agent_commission_bps"]).toBeTruthy();
    expect(snapshot.tables["public.escrow_config"].columns["agent_float_alert_threshold_cents"]).toBeTruthy();
  });
});
