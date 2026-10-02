// === W60 persistence ===
/**
 * J605 — W60-A MEDIUM #15: the WA suppression list is fail-CLOSED in
 * production (a store outage must never silently re-send to an
 * opted-out/failed number) while staying fail-open in dev/test.
 *
 *   1. Functional (sim runs non-prod): a suppressed number is honored via
 *      the PG backing table even with no Redis cache; a BROKEN db degrades
 *      fail-open in non-prod (legitimate sends are not blocked).
 *   2. Contract: the production branches fail closed — isSuppressed treats
 *      a store error as SUPPRESSED, getSuppressedPhones aborts the
 *      broadcast, and cache failures raise pageable telemetry
 *      (captureException), never silently re-send.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J605",
  name: "suppression list: PG truth honored; production fail-closed",
  feature: "W60 persistence: waSuppressionList prod fail-closed",
  async run(world: World) {
    const svc = await import("../../server/services/waSuppressionList");
    const schema = await import("../../drizzle/schema");
    const { tenantId } = await seedUcTenant(world, "605", 6051);
    const phone = world.newPhone("605");

    // ── 1. Suppressed number honored from PG (no Redis in sim) ─────────
    assert((await svc.isSuppressed(world.db, tenantId, phone)) === false, "unknown phone not suppressed");
    const added = await svc.addToSuppressionList(world.db, tenantId, phone, { reasonCode: 131026, source: "j604" });
    assert(added, "suppression recorded");
    assert((await svc.isSuppressed(world.db, tenantId, phone)) === true, "suppressed phone honored without Redis cache");
    const set = await svc.getSuppressedPhones(world.db, tenantId);
    assert(set.has(phone.replace(/[^\d]/g, "").replace(/^0+/, "")), "broadcast audience excludes suppressed phone");

    // Non-prod stays fail-open for a broken store (never block legit sends).
    // Use a phone that was never cached so the check exercises the PG path.
    const uncached = world.newPhone("605x");
    const brokenDb = { select: () => { throw new Error("db down"); } } as any;
    assert((await svc.isSuppressed(brokenDb, tenantId, uncached)) === false, "non-prod degrades fail-open");

    // ── 2. Production fail-closed contract (source shape) ───────────────
    const src = fs.readFileSync(path.join(ROOT, "server/services/waSuppressionList.ts"), "utf-8");
    assert(/if \(isProd\) \{[\s\S]{0,400}return true;/.test(src), "isSuppressed treats store outage as SUPPRESSED in prod");
    assert(/getSuppressedPhones[\s\S]{0,1200}if \(isProd\) \{[\s\S]{0,300}throw e;/.test(src), "getSuppressedPhones aborts broadcast in prod");
    assert(src.includes('operation: "cacheAdd"'), "prod cache failures raise captureException telemetry");

    await world.db.delete(schema.waSuppressionList)
      .where(and(eq(schema.waSuppressionList.tenantId, tenantId))).catch(() => {});
  },
};
