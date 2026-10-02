// === W60 persistence ===
/**
 * W60 migration shape — drizzle/0180_w60_server_persistence.sql + journal
 * idx 180 + snapshot chained from 0179 (W59 banking-pos), cumulative union.
 * Guards the hand-written migration against drift; the table shapes asserted
 * here are the CONTRACTS consumed by services/bankingChat.ts
 * (pending_cico_intents — atomic exactly-once CICO confirm claims) and
 * services/medusaPromoSync.ts (medusa_promo_outbox — durable promo-push
 * retry queue swept by /api/scheduled/medusa-promo-outbox).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0180_w60_server_persistence.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0180_w60_server_persistence_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0179_w59_banking_pos_snapshot.json"), "utf8"));

describe("0180_w60_server_persistence.sql", () => {
  it("creates pending_cico_intents with the atomic-claim contract", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pending_cico_intents"');
    for (const frag of [
      '"key" text PRIMARY KEY NOT NULL',
      '"tenantId" varchar(36) NOT NULL',
      '"agentIdentity" varchar(64)',
      '"kind" varchar(16) NOT NULL',
      '"phone" varchar(32) NOT NULL',
      '"amountCents" integer NOT NULL',
      '"payload" jsonb',
      '"expiresAt" timestamp NOT NULL',
      '"createdAt" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "pending_cico_intents_expiry_idx"');
  });

  it("creates medusa_promo_outbox with the dedupe + retry contract", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "medusa_promo_outbox"');
    for (const frag of [
      '"tenantId" varchar(36) NOT NULL',
      '"promoCode" varchar(64) NOT NULL',
      '"op" varchar(16) NOT NULL',
      '"payload" jsonb NOT NULL',
      '"status" varchar(16) DEFAULT \'pending\' NOT NULL',
      '"attempts" integer DEFAULT 0 NOT NULL',
      '"lastError" text',
      '"createdAt" timestamp DEFAULT now() NOT NULL',
      '"updatedAt" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "medusa_promo_outbox_dedupe_uniq"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "medusa_promo_outbox_status_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0179 (W59 banking-pos) and registers journal idx 180", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0180_w60_server_persistence");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(180);
    expect(journal.entries.filter((e: any) => e.idx === 180)).toHaveLength(1);
    // FULL snapshot union: everything in 0179 carries over, plus W60 tables.
    for (const t of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[t], `union carries ${t}`).toBeTruthy();
    }
    for (const t of [
      "public.pending_cico_intents",
      "public.medusa_promo_outbox",
    ]) expect(snapshot.tables[t], `snapshot has ${t}`).toBeTruthy();
    expect(snapshot.tables["public.pending_cico_intents"].columns["expiresAt"]).toBeTruthy();
    expect(snapshot.tables["public.medusa_promo_outbox"].indexes["medusa_promo_outbox_dedupe_uniq"].isUnique).toBe(true);
  });
});
