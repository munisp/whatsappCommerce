/**
 * W40 migration shape — drizzle/0126_messaging_resilience.sql + journal
 * idx 126 + snapshot chained from the 0122 tip. Guards the hand-written
 * messaging-resilience migration (MSG-2 template DISABLED status, MSG-3
 * broadcast circuit-breaker pause columns) against drift; the shapes
 * asserted here are the CONTRACT consumed by
 * server/services/templateStatus.ts and server/routers/broadcast.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql126 = readFileSync(join(DRIZZLE, "0126_messaging_resilience.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap126 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0126_messaging_resilience_snapshot.json"), "utf8"));
// W40 merger: journal re-chained 0122 → 0123 (A) → 0124 (B) → 0125 (B) →
// 0126 (C), so the 0126 snapshot now chains from the 0125 tip (was 0122 on
// Coder C's branch).
const snap125 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0125_kyb_ubo_fields_snapshot.json"), "utf8"));

describe("0126_messaging_resilience.sql", () => {
  it("adds the template DISABLED enum value (MSG-2, additive)", () => {
    expect(sql126).toContain(`ALTER TYPE "template_approval_status" ADD VALUE IF NOT EXISTS 'disabled'`);
  });

  it("adds the broadcast paused enum value + pause columns (MSG-3, additive)", () => {
    expect(sql126).toContain(`ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'paused'`);
    expect(sql126).toContain(`ALTER TABLE "broadcast_campaigns" ADD COLUMN IF NOT EXISTS "pausedReason" varchar(500)`);
    expect(sql126).toContain(`ALTER TABLE "broadcast_campaigns" ADD COLUMN IF NOT EXISTS "pausedAt" timestamp`);
  });

  it("is additive only (no drops, no renames, no table recreation)", () => {
    expect(sql126).not.toMatch(/DROP\s/i);
    expect(sql126).not.toMatch(/RENAME/i);
    expect(sql126).not.toMatch(/CREATE TABLE/i);
  });

  it("documents the MSG-2/MSG-3 rationale", () => {
    expect(sql126).toContain("MSG-2");
    expect(sql126).toContain("MSG-3");
    expect(sql126).toContain("circuit breaker");
  });
});

describe("0126 journal + snapshot", () => {
  it("is journaled after 0122 at idx 126", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0126_messaging_resilience");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(126);
    const i122 = journal.entries.findIndex((e: any) => e.tag === "0122_payment_disputes");
    const i126 = journal.entries.findIndex((e: any) => e.tag === "0126_messaging_resilience");
    expect(i126).toBeGreaterThan(i122);
  });

  it("snapshot chains from the 0125 tip (W40 merger re-chain 0122→0123→0124→0125→0126)", () => {
    expect(snap126.prevId).toBe(snap125.id);
    expect(snap126.id).not.toBe(snap125.id);
    // Cumulative: B's KYC columns must still be present in the 0126 snapshot.
    expect(snap126.tables["public.kyc_applications"].columns.uboName).toBeTruthy();
    expect(snap126.tables["public.kyc_documents"].columns.erasedAt).toBeTruthy();
  });

  it("snapshot carries the additive enum values + columns", () => {
    expect(snap126.enums["public.template_approval_status"].values).toContain("disabled");
    expect(snap126.enums["public.broadcast_status"].values).toContain("paused");
    const cols = snap126.tables["public.broadcast_campaigns"].columns;
    expect(cols.pausedReason).toMatchObject({ type: "varchar(500)", notNull: false });
    expect(cols.pausedAt).toMatchObject({ type: "timestamp", notNull: false });
  });
});
