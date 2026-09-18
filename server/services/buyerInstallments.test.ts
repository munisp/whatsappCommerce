/**
 * W41 Coder A (UC-1) — buyer installments: migration 0127 shape +
 * journal/snapshot chaining (hand-maintained per the 0106–0126 pattern;
 * drizzle-kit generate is unavailable offline) + pure schedule math +
 * exactly-once references + eligibility config parsing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeBuyerSchedule,
  buildInstallmentOfferText,
  bipDownRef,
  bipCaptureRef,
  bipReorderRef,
  BUYER_INSTALLMENT_CHOICES,
  DEFAULT_BUYER_INSTALLMENT_CONFIG,
  getBuyerInstallmentConfig,
} from "./buyerInstallments";

const DRIZZLE = join(__dirname, "../../drizzle");
const sql = readFileSync(join(DRIZZLE, "0127_buyer_credit.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0127_buyer_credit_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0126_messaging_resilience_snapshot.json"), "utf8"));
const schemaTs = readFileSync(join(DRIZZLE, "schema.ts"), "utf8");

describe("0127_buyer_credit.sql", () => {
  it("creates buyer_installment_plans additively and idempotently", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "buyer_installment_plans"');
    expect(sql).toContain('"order_id" varchar(36) NOT NULL');
    expect(sql).toContain('"total_cents" bigint NOT NULL');
    expect(sql).toContain('"down_payment_cents" bigint NOT NULL');
    expect(sql).toContain('"down_payment_ref" varchar(160) NOT NULL');
    expect(sql).toContain('"schedule" jsonb NOT NULL');
    expect(sql).toContain('"status" varchar(20) DEFAULT \'pending_down\' NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "buyer_installment_plans_down_ref_uniq"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "buyer_installment_plans_order_idx"');
    expect(sql).not.toMatch(/DROP/i);
  });

  it("creates buyer_plan_charges (W38 durable-ledger pattern) additively", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "buyer_plan_charges"');
    expect(sql).toContain('"reference" varchar(160) NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "buyer_plan_charges_reference_uniq"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "buyer_plan_charges_status_idx"');
    expect(sql).not.toMatch(/DROP/i);
  });

  it("creates customer_payment_tokens with encrypted token + consent audit", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "customer_payment_tokens"');
    expect(sql).toContain('"token_enc" text NOT NULL');
    expect(sql).toContain('"consent_text" text NOT NULL');
    expect(sql).toContain('"status" varchar(16) DEFAULT \'active\' NOT NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "customer_payment_tokens_buyer_idx"');
    // NEVER a PAN column.
    expect(sql).not.toMatch(/"pan"|card_number/i);
  });

  it("is registered as journal idx 127 chaining from the 0126 snapshot", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0127_buyer_credit");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(127);
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
  });

  it("snapshot carries all three tables, matching schema.ts", () => {
    const plan = snapshot.tables["public.buyer_installment_plans"];
    expect(plan).toBeDefined();
    expect(plan.columns.total_cents).toMatchObject({ type: "bigint", notNull: true });
    expect(plan.columns.status).toMatchObject({ type: "varchar(20)", notNull: true, default: "'pending_down'" });
    expect(plan.indexes.buyer_installment_plans_down_ref_uniq).toBeDefined();
    const charges = snapshot.tables["public.buyer_plan_charges"];
    expect(charges).toBeDefined();
    expect(charges.columns.reference).toMatchObject({ type: "varchar(160)", notNull: true });
    expect(charges.indexes.buyer_plan_charges_reference_uniq).toBeDefined();
    const tokens = snapshot.tables["public.customer_payment_tokens"];
    expect(tokens).toBeDefined();
    expect(tokens.columns.token_enc).toMatchObject({ type: "text", notNull: true });
    expect(tokens.columns.consent_text).toMatchObject({ type: "text", notNull: true });
    // cumulative: everything from 0126 is still present
    expect(Object.keys(snapshot.tables).length).toBe(Object.keys(prevSnapshot.tables).length + 3);
    expect(schemaTs).toContain("=== W41 buyer-credit (Coder A, UC-1/UC-6; migration 0127) ===");
    expect(schemaTs).toContain('export const buyerInstallmentPlans = pgTable("buyer_installment_plans"');
    expect(schemaTs).toContain('export const buyerPlanCharges = pgTable("buyer_plan_charges"');
    expect(schemaTs).toContain('export const customerPaymentTokens = pgTable("customer_payment_tokens"');
  });
});

describe("computeBuyerSchedule (integer cents)", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("splits evenly when divisible", () => {
    const { downPaymentCents, schedule } = computeBuyerSchedule(900_00, 3, now);
    expect(downPaymentCents).toBe(300_00);
    expect(schedule).toHaveLength(2);
    expect(schedule.map((e) => e.amountCents)).toEqual([300_00, 300_00]);
    expect(downPaymentCents + schedule.reduce((a, e) => a + e.amountCents, 0)).toBe(900_00);
  });

  it("remainder rides the LAST part; parts sum exactly", () => {
    const { downPaymentCents, schedule } = computeBuyerSchedule(100_00, 3, now);
    expect(downPaymentCents).toBe(33_33);
    expect(schedule.map((e) => e.amountCents)).toEqual([33_33, 33_34]);
    expect(downPaymentCents + schedule.reduce((a, e) => a + e.amountCents, 0)).toBe(100_00);
  });

  it("weekly cadence, seq starts at 2 (part 1 = down payment)", () => {
    const { schedule } = computeBuyerSchedule(400_00, 4, now);
    expect(schedule.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(new Date(schedule[0].dueAt).getTime() - now.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(schedule.every((e) => e.status === "due" && e.paidAt === null)).toBe(true);
  });

  it("rejects non-integer / non-positive totals and bad installment counts", () => {
    expect(() => computeBuyerSchedule(0, 3, now)).toThrowError(/positive integer/);
    expect(() => computeBuyerSchedule(10.5, 3, now)).toThrowError(/positive integer/);
    expect(() => computeBuyerSchedule(100_00, 5, now)).toThrowError(/installments must be one of/);
    for (const n of BUYER_INSTALLMENT_CHOICES) {
      expect(() => computeBuyerSchedule(100_00, n, now)).not.toThrow();
    }
  });
});

describe("exactly-once references", () => {
  it("are deterministic and bounded", () => {
    expect(bipDownRef("p1")).toBe("bipdown:p1");
    expect(bipCaptureRef("p1", 2)).toBe("bipcap:p1:2");
    expect(bipReorderRef("o1")).toBe("bipreorder:o1");
    expect(bipCaptureRef("x".repeat(200), 3).length).toBeLessThanOrEqual(128);
  });
});

describe("buildInstallmentOfferText", () => {
  it("quotes the down payment for the largest offered choice", () => {
    const text = buildInstallmentOfferText(900_00, { enabled: true, minTotalCents: 0, choices: [3, 6] });
    expect(text).toContain("PAY IN 6");
    expect(text).toContain("₦150.00"); // 90000/6
  });
});

describe("getBuyerInstallmentConfig (tenant settings, fail-closed)", () => {
  const dbFor = (settings: unknown) => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings }] }),
      }),
    }),
  });

  it("defaults to disabled when unset", async () => {
    expect(await getBuyerInstallmentConfig(dbFor(null), "t1")).toEqual(DEFAULT_BUYER_INSTALLMENT_CONFIG);
    expect((await getBuyerInstallmentConfig(dbFor({ buyerInstallments: { enabled: false } }), "t1")).enabled).toBe(false);
  });

  it("parses enabled config with threshold + valid choices only", async () => {
    const cfg = await getBuyerInstallmentConfig(
      dbFor({ buyerInstallments: { enabled: true, minTotalCents: 500_00, choices: [3, 99] } }),
      "t1",
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.minTotalCents).toBe(500_00);
    expect(cfg.choices).toEqual([3]);
  });

  it("falls back to all choices when the list is empty/invalid", async () => {
    const cfg = await getBuyerInstallmentConfig(
      dbFor({ buyerInstallments: { enabled: true, minTotalCents: 0, choices: [] } }),
      "t1",
    );
    expect(cfg.choices).toEqual([...BUYER_INSTALLMENT_CHOICES]);
  });
});
