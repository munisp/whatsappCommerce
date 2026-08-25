/**
 * W32 pay-over-time (Coder A) — migration 0106 shape + journal/snapshot
 * consistency (hand-maintained per the 0051–0105 pattern; drizzle-kit
 * generate is unavailable offline) + pure schedule/early-settle math.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeSchedule, earlySettleAmountCents, potMerchantCopy, potCaptureRef, potFundingRef } from "./payOverTime";

const DRIZZLE = join(__dirname, "../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0106_installment_plans.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0106_installment_plans_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0105_ar_invoice_payments_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0106_installment_plans.sql", () => {
  it("creates installment_plans additively and idempotently", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "installment_plans"');
    expect(sql).toContain('"fee_bps" integer NOT NULL');
    expect(sql).toContain('"schedule" jsonb');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "installment_plans_tenant_status_idx"');
    expect(sql).not.toMatch(/DROP/i);
  });

  it("adds platform config + bill metadata columns additively", () => {
    expect(sql).toContain('ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "pay_over_time_min_score" integer DEFAULT 600 NOT NULL');
    expect(sql).toContain('ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "pay_over_time_fee_bps" integer DEFAULT 250 NOT NULL');
    expect(sql).toContain('ALTER TABLE "escrow_config" ADD COLUMN IF NOT EXISTS "pay_over_time_prorate_early_fee" boolean DEFAULT false NOT NULL');
    expect(sql).toContain('ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "metadata" jsonb');
  });

  it("is registered as journal idx 106 chaining from the 0105 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0106_installment_plans");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(106);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries installment_plans + the new columns, matching schema.ts", () => {
    const t = snapshot.tables["public.installment_plans"];
    expect(t).toBeDefined();
    expect(t.columns.principal_cents).toMatchObject({ type: "bigint", notNull: true });
    expect(t.columns.status).toMatchObject({ type: "varchar(16)", notNull: true });
    expect(t.indexes.installment_plans_tenant_status_idx).toBeDefined();
    const ec = snapshot.tables["public.escrow_config"].columns;
    expect(ec.pay_over_time_min_score).toMatchObject({ type: "integer", notNull: true, default: 600 });
    expect(snapshot.tables["public.vendor_bills"].columns.metadata).toMatchObject({ type: "jsonb" });
    expect(schemaTs).toContain('=== W32 pay-over-time ===');
    expect(schemaTs).toContain('export const installmentPlans = pgTable("installment_plans"');
    expect(schemaTs).toContain('payOverTimeMinScore: integer("pay_over_time_min_score")');
    expect(schemaTs).toContain('metadata:       jsonb("metadata")');
  });
});

describe("payOverTime schedule math (integer cents)", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("splits principal + fee exactly (sum invariant)", () => {
    const { feeCents, totalCents, schedule } = computeSchedule(300_000, 250, 3, now);
    expect(feeCents).toBe(7_500);
    expect(totalCents).toBe(307_500);
    expect(schedule).toHaveLength(3);
    expect(schedule.reduce((a, e) => a + e.amountCents, 0)).toBe(totalCents);
    expect(schedule.reduce((a, e) => a + e.principalCents, 0)).toBe(300_000);
    expect(schedule.reduce((a, e) => a + e.feeCents, 0)).toBe(feeCents);
    expect(schedule.every((e) => e.status === "due" && e.paidAt === null)).toBe(true);
  });

  it("rounding remainder rides the last installment", () => {
    const { totalCents, schedule } = computeSchedule(100_001, 250, 6, now);
    expect(schedule.reduce((a, e) => a + e.amountCents, 0)).toBe(totalCents);
    const first = schedule.slice(0, -1);
    expect(new Set(first.map((e) => e.amountCents)).size).toBe(1);
    // monthly cadence
    expect(new Date(schedule[0].dueAt).getTime()).toBe(now.getTime() + 30 * 24 * 3600 * 1000);
  });

  it("rejects unsupported installment counts", () => {
    expect(() => computeSchedule(100_000, 250, 4 as any, now)).toThrowError(/installments must be one of/);
    expect(() => computeSchedule(0, 250, 3, now)).toThrowError(/positive integer/);
  });

  it("early settle: full fee by default, prorated future fee when enabled", () => {
    const { schedule } = computeSchedule(300_000, 250, 3, now);
    const paid = { ...schedule[0], status: "paid" as const, paidAt: now.toISOString() };
    const rest = [paid, schedule[1], schedule[2]];
    // default: everything unpaid is charged in full
    expect(earlySettleAmountCents(rest, { prorateEarlyFee: false, now }))
      .toBe(schedule[1].amountCents + schedule[2].amountCents);
    // prorated: future installments lose their fee slice
    const future = new Date(now.getTime() + 200 * 24 * 3600 * 1000); // after all due dates → none future
    expect(earlySettleAmountCents(rest, { prorateEarlyFee: true, now: future }))
      .toBe(schedule[1].amountCents + schedule[2].amountCents);
    expect(earlySettleAmountCents(rest, { prorateEarlyFee: true, now }))
      .toBe(schedule[1].principalCents + schedule[2].principalCents);
  });

  it("deterministic references + honest merchant copy", () => {
    expect(potFundingRef("abc")).toBe("potfund:abc");
    expect(potCaptureRef("p1", 2)).toBe("potcap:p1:2");
    expect(potMerchantCopy(307_500, 3)).toMatch(/^Vendor paid in full · you're repaying ₦3,075\.00 in 3 installments$/);
  });
});
