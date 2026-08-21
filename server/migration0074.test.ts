/**
 * W27 migration shape — drizzle/0074_storefronts.sql +
 * 0075_tenant_i18n_overrides.sql + journal idx 74/75 + snapshot consistency.
 * Guards the hand-written migrations against drift; the table shapes asserted
 * here are the CONTRACT consumed by server/services/storefront.ts and
 * server/routers/i18n.ts. NOTE: chained from 0069's snapshot; the merge
 * orchestrator re-chains all W27 branches in idx order.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(__dirname, "../drizzle");
const sql74 = readFileSync(join(DRIZZLE, "0074_storefronts.sql"), "utf8");
const sql75 = readFileSync(join(DRIZZLE, "0075_tenant_i18n_overrides.sql"), "utf8");
const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8"));
const snap74 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0074_snapshot.json"), "utf8"));
const snap75 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0075_snapshot.json"), "utf8"));
const snap69 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0069_snapshot.json"), "utf8"));
const snap73 = JSON.parse(readFileSync(join(DRIZZLE, "meta/0073_snapshot.json"), "utf8"));

describe("0074_storefronts.sql", () => {
  it("creates storefronts with the contract columns", () => {
    expect(sql74).toContain('CREATE TABLE IF NOT EXISTS "storefronts"');
    for (const frag of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL',
      '"tenant_id" varchar(36) NOT NULL',
      '"slug" varchar(80) NOT NULL',
      '"hero_text" varchar(280)',
      '"theme_color" varchar(16) DEFAULT \'#075E54\' NOT NULL',
      '"is_visible" boolean DEFAULT false NOT NULL',
      '"show_location" boolean DEFAULT false NOT NULL',
      '"default_locale" varchar(8) DEFAULT \'en\' NOT NULL',
    ]) expect(sql74).toContain(frag);
  });
  it("enforces one storefront per tenant and globally unique slugs", () => {
    expect(sql74).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "storefronts_tenant_uidx"');
    expect(sql74).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "storefronts_slug_uidx"');
  });
  it("is journaled at idx 74 with a chained snapshot", () => {
    const entry = journal.entries.find((e: any) => e.idx === 74);
    expect(entry?.tag).toBe("0074_storefronts");
    // Post-merge (Wave 27): the snapshot chain was rebuilt as a cumulative
    // union across all W27 migrations, so 0074 chains off 0073 (not 0069).
    expect(snap74.prevId).toBe(snap73.id);
    expect(snap74.tables["public.storefronts"]).toBeTruthy();
    expect(snap74.tables["public.storefronts"].columns.slug.notNull).toBe(true);
    expect(snap74.tables["public.storefronts"].indexes["storefronts_slug_uidx"].isUnique).toBe(true);
    // Additive: all 0069 tables carried forward.
    for (const t of Object.keys(snap69.tables)) expect(snap74.tables[t], t).toBeTruthy();
  });
});

describe("0075_tenant_i18n_overrides.sql", () => {
  it("creates tenant_i18n_overrides with the contract columns", () => {
    expect(sql75).toContain('CREATE TABLE IF NOT EXISTS "tenant_i18n_overrides"');
    for (const frag of [
      '"tenant_id" varchar(36) NOT NULL',
      '"locale" varchar(8) NOT NULL',
      '"key" varchar(64) NOT NULL',
      '"text" text NOT NULL',
    ]) expect(sql75).toContain(frag);
    expect(sql75).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "tenant_i18n_overrides_tenant_locale_key_uidx"');
  });
  it("is journaled at idx 75 with a chained snapshot", () => {
    const entry = journal.entries.find((e: any) => e.idx === 75);
    expect(entry?.tag).toBe("0075_tenant_i18n_overrides");
    expect(snap75.prevId).toBe(snap74.id);
    expect(snap75.tables["public.tenant_i18n_overrides"]).toBeTruthy();
    expect(snap75.tables["public.storefronts"]).toBeTruthy(); // cumulative
    for (const t of Object.keys(snap69.tables)) expect(snap75.tables[t], t).toBeTruthy();
  });
});
