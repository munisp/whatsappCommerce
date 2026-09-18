/**
 * W38 migration shape — drizzle/0119_refund_money_integrity.sql + journal
 * idx 119 + snapshot chain from 0118. Guards the hand-written migration
 * (PAY-2 refund_attempts, PAY-3 merchant_clawbacks, PAY-7 refund_pending
 * enum) against drift; the table shapes asserted here are the CONTRACT
 * consumed by server/services/payments/refunds.ts, server/routers/sla.ts,
 * server/routers/orderCrud.ts and server/routers/escrow.ts. The merge
 * orchestrator re-chains W38 branches in idx order.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql119 = readFileSync(join(DRIZZLE, "0119_refund_money_integrity.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap119 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0119_refund_money_integrity_snapshot.json"), "utf8"));
const snap118 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0118_telegram_identities_snapshot.json"), "utf8"));

describe("0119_refund_money_integrity.sql", () => {
  it("creates refund_attempts with the idempotency contract columns", () => {
    expect(sql119).toContain('CREATE TABLE IF NOT EXISTS "refund_attempts"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"refund_id" varchar(36)',
      '"order_id" varchar(36)',
      '"provider" varchar(32) NOT NULL',
      '"provider_ref" varchar(256)',
      '"idempotency_key" varchar(128) NOT NULL',
      '"amount_cents" bigint NOT NULL',
      '"status" varchar(24) NOT NULL',
    ]) expect(sql119).toContain(frag);
    expect(sql119).toContain('CREATE INDEX IF NOT EXISTS "refund_attempts_refund_idx"');
    expect(sql119).toContain('CREATE INDEX IF NOT EXISTS "refund_attempts_idem_idx"');
  });

  it("creates merchant_clawbacks with one-clawback-per-refund uniqueness", () => {
    expect(sql119).toContain('CREATE TABLE IF NOT EXISTS "merchant_clawbacks"');
    for (const frag of [
      '"tenant_id" varchar(36) NOT NULL',
      '"order_id" varchar(36) NOT NULL',
      '"refund_id" varchar(36)',
      '"escrow_id" varchar(36)',
      '"amount_cents" bigint NOT NULL',
      '"status" varchar(24) DEFAULT \'pending\' NOT NULL',
    ]) expect(sql119).toContain(frag);
    expect(sql119).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "merchant_clawbacks_refund_uniq"');
  });

  it("adds the honest refund_pending payment status (PAY-7, additive enum)", () => {
    expect(sql119).toContain("ALTER TYPE \"payment_status\" ADD VALUE IF NOT EXISTS 'refund_pending'");
  });

  it("is journaled at idx 119 with a snapshot chained from 0118", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0119_refund_money_integrity");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(119);
    expect(snap119.prevId).toBe(snap118.id);
    expect(snap119.tables["public.refund_attempts"]).toBeTruthy();
    expect(snap119.tables["public.merchant_clawbacks"]).toBeTruthy();
  });
});
