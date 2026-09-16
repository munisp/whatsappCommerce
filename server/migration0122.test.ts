/**
 * W39 migration shape — drizzle/0122_payment_disputes.sql + journal idx 122
 * + snapshot chain from 0121. Guards the hand-written PAY-8 migration
 * (payment_disputes) against drift; the table shape asserted here is the
 * CONTRACT consumed by server/services/payments/disputes.ts and the
 * paystack/flutterwave webhook handlers in server/_core/index.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql122 = readFileSync(join(DRIZZLE, "0122_payment_disputes.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap122 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0122_payment_disputes_snapshot.json"), "utf8"));
const snap121 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0121_wholesale_fulfillment_untracked_snapshot.json"), "utf8"));

describe("0122_payment_disputes.sql", () => {
  it("creates payment_disputes with the PAY-8 contract columns", () => {
    expect(sql122).toContain('CREATE TABLE IF NOT EXISTS "payment_disputes"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"order_id" varchar(36)',
      '"provider" varchar(32) NOT NULL',
      '"provider_ref" varchar(256) NOT NULL',
      '"kind" varchar(24) NOT NULL',
      '"amount_cents" bigint',
      '"status" varchar(24) DEFAULT \'open\' NOT NULL',
      '"payload" jsonb',
    ]) expect(sql122).toContain(frag);
    expect(sql122).toContain('CREATE INDEX IF NOT EXISTS "payment_disputes_tenant_idx"');
    expect(sql122).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "payment_disputes_uniq"');
  });

  it("documents debit-on-lost semantics (PAY-8 doctrine)", () => {
    expect(sql122).toContain("Debit-on-lost semantics");
    expect(sql122).toContain("merchant_clawbacks");
  });

  it("is journaled at idx 122 with a snapshot chained from 0121", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0122_payment_disputes");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(122);
    expect(snap122.prevId).toBe(snap121.id);
    expect(snap122.tables["public.payment_disputes"]).toBeTruthy();
  });
});
