// === W66 learning ===
/**
 * J628 — R8(d) search zero-results → demand signals
 * (services/demandSignals.ts):
 *   1. Zero-result queries aggregate per tenant (top queries + counts) via
 *      learning.demandSummary (the MerchantDashboard insight card source).
 *   2. runDemandDigest sends ONE weekly WA/TG digest to the merchant admin;
 *      a same-week re-fire sends 0 (proactive_nudges ISO-week claim).
 *   3. Non-zero-result queries never appear; single-occurrence noise is
 *      below the digest threshold.
 *   4. /api/scheduled/demand-digest registered + allowlisted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN_PHONE = "2348062800001";

export const journey: Journey = {
  id: "J628",
  name: "zero-result demand summary + weekly digest idempotent per ISO week",
  feature: "W66 R8(d) demand signals",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    try {
      await world.patchTenantSettings({
        adminPhone: ADMIN_PHONE,
        marketingFrequency: { ...(before?.marketingFrequency ?? {}), quietStart: "00:00", quietEnd: "00:00" },
      });

      // ── Seeds: recurring zero-result + noise + successful searches ────
      await world.db.insert(schema.searchQueries).values([
        { tenantId: TENANT_ID, channel: "wa", query: "j628 garri", resultsCount: 0, zeroResult: true },
        { tenantId: TENANT_ID, channel: "web", query: "J628 Garri", resultsCount: 0, zeroResult: true },
        { tenantId: TENANT_ID, channel: "wa", query: "j628 garri", resultsCount: 0, zeroResult: true },
        { tenantId: TENANT_ID, channel: "wa", query: "j628 plantain chips", resultsCount: 4, zeroResult: false },
        { tenantId: TENANT_ID, channel: "wa", query: "j628 one-off noise", resultsCount: 0, zeroResult: true },
      ]).onConflictDoNothing();

      const svc = await import("../../server/services/demandSignals");

      // ── Summary (dashboard card source, via tenant router) ─────────────
      const caller = await tenantCaller(TENANT_ID);
      const summary = await caller.learning.demandSummary({ tenantId: TENANT_ID });
      const garri = summary.find((s: any) => s.query === "j628 garri");
      assert(garri && garri.count === 3, `garri aggregated (case-insensitive): ${JSON.stringify(garri)}`);
      assert(!summary.some((s: any) => s.query.includes("plantain")), "successful search excluded");

      // ── Weekly digest: first fire sends, second same-week fire 0 ──────
      const d1 = await svc.runDemandDigest();
      assert(d1.digestsSent === 1, `digest 1 sent (${d1.digestsSent})`);
      const d2 = await svc.runDemandDigest();
      assert(d2.digestsSent === 0, `digest 2 suppressed (${d2.digestsSent})`);

      // ── Scheduler parity ───────────────────────────────────────────────
      const indexSrc = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf8");
      assert(indexSrc.includes('"/api/scheduled/demand-digest"'), "route registered");
      const schedSrc = fs.readFileSync(path.join(ROOT, "services/scheduler/scheduler.mjs"), "utf8");
      assert(schedSrc.includes("/api/scheduled/demand-digest"), "allowlist entry");
    } finally {
      await world.patchTenantSettings(before ?? {});
    }
  },
};
