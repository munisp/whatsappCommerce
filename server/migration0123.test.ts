/**
 * W40 migration shape — drizzle/0123_tenant_channel_uniqueness.sql + journal
 * idx 123 + snapshot chain from 0122. Guards the hand-written TEN-3
 * migration (channel-identity uniqueness backstop) against drift; the index
 * names asserted here are the CONTRACT relied on by
 * simulation/journeys/j274-channel-hijack-db-backstop.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql123 = readFileSync(join(DRIZZLE, "0123_tenant_channel_uniqueness.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap123 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0123_tenant_channel_uniqueness_snapshot.json"), "utf8"));
const snap122 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0122_payment_disputes_snapshot.json"), "utf8"));

describe("0123_tenant_channel_uniqueness.sql", () => {
  it("creates the partial unique index on tenants.whatsappPhoneNumberId", () => {
    expect(sql123).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "tenants_wa_phone_number_id_uidx"');
    expect(sql123).toContain('"whatsappPhoneNumberId" IS NOT NULL');
  });

  it("creates the telegram botUsername expression index (case-insensitive)", () => {
    expect(sql123).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "tenants_telegram_bot_username_uidx"');
    expect(sql123).toContain("lower(settings->'telegram'->>'botUsername')");
  });

  it("documents the dedupe doctrine (TEN-3)", () => {
    expect(sql123).toContain("Dedupe doctrine");
    expect(sql123).toContain("hijack");
  });

  it("is journaled at idx 123 with a snapshot chained from 0122", () => {
    const entry = journal.entries.find((e: any) => e.tag === "0123_tenant_channel_uniqueness");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(123);
    expect(snap123.prevId).toBe(snap122.id);
  });
});
