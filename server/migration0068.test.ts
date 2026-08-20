/**
 * W25 migration shape — drizzle/0068_geo_discovery.sql + journal idx 68 +
 * snapshot consistency. Guards the hand-written migration against drift; the
 * table shapes asserted here are the CONTRACT consumed by
 * server/services/geoDiscovery.ts (merchant_locations + sponsored_listings).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql = readFileSync(join(DRIZZLE, "0068_geo_discovery.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0068_snapshot.json"), "utf8"));
const prevSnapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta/0067_snapshot.json"), "utf8"));

describe("0068_geo_discovery.sql", () => {
  it("creates merchant_locations with the contract columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "merchant_locations"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"latitude" numeric(10, 7) NOT NULL',
      '"longitude" numeric(10, 7) NOT NULL',
      '"service_radius_km" numeric(8, 3) DEFAULT 5 NOT NULL',
      '"discoverable" boolean DEFAULT false NOT NULL',
      '"delivery_zones" jsonb',
      '"open_hours" jsonb',
      '"geohash" text NOT NULL',
      '"created_at" timestamp DEFAULT now() NOT NULL',
      '"updated_at" timestamp DEFAULT now() NOT NULL',
    ]) expect(sql).toContain(frag);
  });

  it("creates sponsored_listings with integer-cents money columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "sponsored_listings"');
    for (const frag of [
      '"daily_budget_cents" integer NOT NULL',
      '"spent_today_cents" integer DEFAULT 0 NOT NULL',
      '"bid_cents" integer DEFAULT 0 NOT NULL',
      '"center_lat" numeric(10, 7) NOT NULL',
      '"center_lng" numeric(10, 7) NOT NULL',
      '"radius_km" numeric(8, 3) DEFAULT 10 NOT NULL',
      '"status" varchar(16) DEFAULT \'draft\' NOT NULL',
      '"categories" jsonb',
    ]) expect(sql).toContain(frag);
  });

  it("indexes geohash + tenantId", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "merchant_locations_geohash_idx"');
    expect(sql).toContain('USING btree ("geohash")');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "merchant_locations_tenant_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "sponsored_listings_tenant_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "sponsored_listings_status_idx"');
  });

  it("is additive-only (no DROP / destructive ALTER)", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE "[^"]+" DROP/i);
  });

  it("chains the snapshot from 0067 and registers journal idx 68", () => {
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    const entry = journal.entries.find((e: any) => e.tag === "0068_geo_discovery");
    expect(entry).toBeTruthy();
    expect(entry.idx).toBe(68);
    expect(entry.when).toBe(1786989200000);
    expect(journal.entries[journal.entries.length - 1].idx).toBeGreaterThanOrEqual(68);
    expect(journal.entries.filter((e: any) => e.idx === 68)).toHaveLength(1);
  });

  it("snapshot carries both tables and stays cumulative", () => {
    const ml = snapshot.tables["public.merchant_locations"];
    const sl = snapshot.tables["public.sponsored_listings"];
    expect(ml).toBeTruthy();
    expect(sl).toBeTruthy();
    for (const c of ["id", "tenant_id", "latitude", "longitude", "geohash", "discoverable", "service_radius_km", "created_at", "updated_at"]) {
      expect(ml.columns[c], `merchant_locations.${c}`).toBeTruthy();
    }
    for (const c of ["id", "tenant_id", "daily_budget_cents", "spent_today_cents", "bid_cents", "center_lat", "center_lng", "radius_km", "status"]) {
      expect(sl.columns[c], `sponsored_listings.${c}`).toBeTruthy();
    }
    expect(ml.indexes["merchant_locations_geohash_idx"]).toBeTruthy();
    expect(ml.indexes["merchant_locations_tenant_idx"]).toBeTruthy();
    expect(sl.indexes["sponsored_listings_tenant_idx"]).toBeTruthy();
    // cumulative: every 0067 table still present
    for (const tbl of Object.keys(prevSnapshot.tables)) {
      expect(snapshot.tables[tbl], `missing prior table ${tbl}`).toBeTruthy();
    }
    // enums carried over unchanged (no new enums in 0068)
    expect(Object.keys(snapshot.enums)).toEqual(Object.keys(prevSnapshot.enums));
  });
});
