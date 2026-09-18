/**
 * W41 (Coder B) migration shape — drizzle/0128_customer_wallet_split.sql +
 * journal idx 128 + snapshot chained from the 0127 tip (W41 merger re-chain
 * 0126 → 0127 → 0128 → 0129 per SPEC_W41). Guards the customer wallet
 * (UC-2) + split payments (UC-3) tables against drift; the shapes asserted
 * here are the CONTRACT consumed by server/services/customerWallet.ts and
 * server/services/splitPayments.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql128 = readFileSync(join(DRIZZLE, "0128_customer_wallet_split.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap128 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0128_customer_wallet_split_snapshot.json"), "utf8"));
// W41 merger re-chain 0126 → 0127 (A) → 0128 (B) → 0129 (C): the 0128
// snapshot now chains from the 0127 tip (was 0126 on Coder B's branch) and
// is cumulative (A's buyer-credit tables remain present).
const snap127 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0127_buyer_credit_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0128_customer_wallet_split.sql", () => {
  it("creates customer_wallets with a never-negative balance backstop", () => {
    expect(sql128).toContain('CREATE TABLE IF NOT EXISTS "customer_wallets"');
    expect(sql128).toContain('"balance_cents" bigint DEFAULT 0 NOT NULL');
    expect(sql128).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "customer_wallets_tenant_phone_uniq"');
    expect(sql128).toContain('CHECK ("balance_cents" >= 0)');
  });

  it("creates the append-only customer_wallet_entries ledger with an idempotency claim", () => {
    expect(sql128).toContain('CREATE TABLE IF NOT EXISTS "customer_wallet_entries"');
    expect(sql128).toContain('"direction" varchar(8) NOT NULL');
    expect(sql128).toContain('"balance_after_cents" bigint NOT NULL');
    expect(sql128).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "customer_wallet_entries_ref_uniq" ON "customer_wallet_entries" USING btree ("ref_id","direction")');
    expect(sql128).toContain('CHECK ("amount_cents" > 0)');
  });

  it("creates split_payment_sessions with status + expiry", () => {
    expect(sql128).toContain('CREATE TABLE IF NOT EXISTS "split_payment_sessions"');
    expect(sql128).toContain('"target_cents" bigint NOT NULL');
    expect(sql128).toContain('"funded_cents" bigint DEFAULT 0 NOT NULL');
    expect(sql128).toContain('"participants" jsonb NOT NULL');
    expect(sql128).toContain(`"status" varchar(20) DEFAULT 'open' NOT NULL`);
    expect(sql128).toContain('"expires_at" timestamp NOT NULL');
  });

  it("is additive only (no drops, no renames, no alterations of pinned tables)", () => {
    expect(sql128).not.toMatch(/DROP\s/i);
    expect(sql128).not.toMatch(/RENAME/i);
    expect(sql128).not.toMatch(/ALTER TABLE "orders"/i);
  });
});

describe("0128 journal + snapshot", () => {
  it("is journaled after 0127 at idx 128 (W41 merger re-chain)", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0128_customer_wallet_split");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(128);
    const i126 = journal.entries.findIndex((e: any) => e.tag === "0126_messaging_resilience");
    const i128 = journal.entries.findIndex((e: any) => e.tag === "0128_customer_wallet_split");
    expect(i128).toBeGreaterThan(i126);
  });

  it("snapshot chains from the 0127 tip (W41 merger re-chain) and carries the new tables", () => {
    expect(snap128.prevId).toBe(snap127.id);
    expect(snap128.id).not.toBe(snap127.id);
    // Cumulative: A's buyer-credit tables must still be present.
    expect(snap128.tables["public.buyer_installment_plans"]).toBeTruthy();
    const w = snap128.tables["public.customer_wallets"];
    expect(w.columns.balance_cents).toMatchObject({ type: "bigint", notNull: true });
    expect(w.indexes.customer_wallets_tenant_phone_uniq.isUnique).toBe(true);
    const e = snap128.tables["public.customer_wallet_entries"];
    expect(e.columns.ref_id).toMatchObject({ type: "varchar(160)", notNull: true });
    expect(e.foreignKeys.customer_wallet_entries_wallet_id_customer_wallets_id_fk.tableTo).toBe("customer_wallets");
    const s = snap128.tables["public.split_payment_sessions"];
    expect(s.columns.participants).toMatchObject({ type: "jsonb", notNull: true });
    expect(s.columns.status).toMatchObject({ type: "varchar(20)", notNull: true });
  });

  it("schema.ts mirrors the migration", () => {
    expect(schemaTs).toContain("=== W41 customer wallet + split payments (Coder B");
    expect(schemaTs).toContain('export const customerWallets = pgTable("customer_wallets"');
    expect(schemaTs).toContain('export const customerWalletEntries = pgTable("customer_wallet_entries"');
    expect(schemaTs).toContain('export const splitPaymentSessions = pgTable("split_payment_sessions"');
    expect(schemaTs).toContain('uniqueIndex("customer_wallet_entries_ref_uniq").on(t.refId, t.direction)');
  });
});
