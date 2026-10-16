// === W53 EVENTS ===
/**
 * W53 migration shape — drizzle/0174_w53_events.sql + journal idx 174 +
 * snapshot chained from 0173. Guards the hand-written migration against
 * drift; the table shape asserted here is the CONTRACT consumed by
 * server/services/events.ts (purchaseTickets claim-first soldCount update,
 * checkInTicket code claim, event_tickets tenant+code uniqueness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0174_w53_events.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0174_w53_events_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0173_w49_wa_media_id_cache_snapshot.json"), "utf8"));

describe("0174_w53_events.sql", () => {
  it("creates events / event_ticket_types / event_tickets with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "events"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "event_ticket_types"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "event_tickets"');
    for (const frag of [
      '"tenantId" varchar(36) NOT NULL',
      '"status" varchar(16) DEFAULT \'draft\' NOT NULL',
      '"priceCents" integer NOT NULL',
      '"soldCount" integer DEFAULT 0 NOT NULL',
      '"maxPerOrder" integer DEFAULT 10 NOT NULL',
      '"code" varchar(24) NOT NULL',
      '"checkedInAt" timestamp',
      '"orderId" varchar(36)',
      '"startsAt" timestamp NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("indexes: unique tenant+code ticket code, event/tenant lookups", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "event_tickets_tenant_code_uq" ON "event_tickets" ("tenantId", "code")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "events_tenant_status_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "event_ticket_types_event_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "event_tickets_order_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "event_tickets_buyer_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0173 and registers journal idx 174", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0174_w53_events");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(174);
    expect(journal.entries.filter((e: any) => e.idx === 174)).toHaveLength(1);
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(174);
    // === W54 merged === journal was extended by 0175/0176 — also assert
    // 0174's own registration + ordering instead of being the tip.
    const idx174 = journal.entries.findIndex((e: any) => e.tag === "0174_w53_events");
    expect(idx174).toBeGreaterThan(0);
    expect(journal.entries[idx174 - 1].idx).toBe(173);
  });

  it("snapshot carries the three new tables and stays cumulative", () => {
    for (const t of ["public.events", "public.event_ticket_types", "public.event_tickets"]) {
      expect(snapshot.tables[t]).toBeTruthy();
    }
    // Cumulative: every 0173 table survives into the 0174 snapshot.
    for (const key of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[key], `missing cumulative table ${key}`).toBeTruthy();
    }
    expect(Object.keys(snapshot.tables).length).toBe(Object.keys(prevSnapshot.tables).length + 3);
    const tt = snapshot.tables["public.event_ticket_types"];
    expect(tt.columns.priceCents.type).toBe("integer");
    expect(tt.columns.soldCount.notNull).toBe(true);
    const tix = snapshot.tables["public.event_tickets"];
    expect(tix.indexes.event_tickets_tenant_code_uq.isUnique).toBe(true);
  });
});
