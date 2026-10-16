// === W54 capabilities ===
/**
 * W54 migration shape — drizzle/0176_w54_membership.sql + journal idx 176 +
 * snapshot chained from 0175 (disputes). W54 MERGE: renumbered 0175→0176
 * (collision with w54/disputes 0175); snapshot is the cumulative union. Guards the hand-written migration against
 * drift; the table shape asserted here is the CONTRACT consumed by
 * server/services/membershipPlans.ts (claim-first join on
 * customer_memberships_live_uidx, integer-cents priceCents, whole-percent
 * discountPercent, integer pointsMultiplier).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0176_w54_membership.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0176_w54_membership_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0175_w54_disputes_snapshot.json"), "utf8"));

describe("0176_w54_membership.sql", () => {
  it("creates membership_plans / customer_memberships with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "membership_plans"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "customer_memberships"');
    for (const frag of [
      '"tenantId" varchar(36) NOT NULL',
      '"priceCents" integer DEFAULT 0 NOT NULL',
      '"period" varchar(8) DEFAULT \'month\' NOT NULL',
      '"discountPercent" integer DEFAULT 0 NOT NULL',
      '"pointsMultiplier" integer DEFAULT 1 NOT NULL',
      '"currentPeriodEnd" timestamp',
      '"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL',
      '"paymentRef" varchar(128)',
    ]) expect(sql).toContain(frag);
  });

  it("indexes: one live membership per (tenant, customer) + lookup indexes", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "customer_memberships_live_uidx" ON "customer_memberships"');
    expect(sql).toContain('WHERE "status" = \'active\'');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "membership_plans_tenant_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "customer_memberships_tenant_customer_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "customer_memberships_plan_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0175 (disputes) and registers journal idx 176", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0176_w54_membership");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(176);
    expect(journal.entries.filter((e: any) => e.idx === 176)).toHaveLength(1);
    // Journal is append-only: 0176 is present exactly once and later waves
    // (e.g. W56 0177) chain AFTER it — the tip is no longer asserted here.
    const idx176 = journal.entries.findIndex((e: any) => e.tag === "0176_w54_membership");
    expect(idx176).toBeGreaterThan(-1);
    expect(journal.entries.slice(idx176 + 1).every((e: any) => e.idx > 176)).toBe(true);
    // Chain intact: 0175 (disputes) still chains from 0174.
    expect(prevSnapshot.prevId).toBeTruthy();
  });

  it("snapshot carries the two new tables and stays cumulative", () => {
    for (const t of ["public.membership_plans", "public.customer_memberships"]) {
      expect(snapshot.tables[t]).toBeTruthy();
    }
    // Cumulative: every 0175 table survives into the 0176 snapshot.
    for (const key of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[key], `missing cumulative table ${key}`).toBeTruthy();
    }
    expect(Object.keys(snapshot.tables).length).toBe(Object.keys(prevSnapshot.tables).length + 2);
    const plans = snapshot.tables["public.membership_plans"];
    expect(plans.columns.priceCents.type).toBe("integer");
    expect(plans.columns.discountPercent.type).toBe("integer");
    const cm = snapshot.tables["public.customer_memberships"];
    expect(cm.indexes.customer_memberships_live_uidx.isUnique).toBe(true);
  });
});
