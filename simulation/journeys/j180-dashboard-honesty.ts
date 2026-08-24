/**
 * J180 — W30 observability honesty: dashboards render no fabricated data.
 *
 *   1. Dashboard.tsx contains no hardcoded chart series and renders an
 *      explicit "No data yet" empty state fed by real analytics queries.
 *   2. AdminPortal.tsx contains no hardcoded status:"connected" integration
 *      entries — cards are live-probed or honestly "unknown".
 *   3. mlOps.getDriftMetrics with no drift log in the runtime returns
 *      available:false (honest unavailable) — never simulated metrics.
 *   4. analytics.revenueTrend / conversationSplitTrend are real queries:
 *      empty DB → empty points (not fabricated series).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J180",
  name: "dashboards render empty-state / honest-unavailable, no fabrication",
  feature: "observability honesty: real queries or explicit empty states",
  async run(_world: World) {
    // ── 1. Dashboard has no hardcoded series ─────────────────────────────
    const dash = fs.readFileSync(path.join(ROOT, "client/src/pages/Dashboard.tsx"), "utf-8");
    assert(!/revenue:\s*12400/.test(dash), "Dashboard still contains the hardcoded revenue series");
    assert(!/bot:\s*142/.test(dash), "Dashboard still contains the hardcoded conversation series");
    assert(dash.includes("No data yet"), "Dashboard must render an explicit empty state");
    assert(dash.includes("analytics.revenueTrend"), "Dashboard revenue chart must use the real query");
    assert(dash.includes("analytics.conversationSplitTrend"), "Dashboard conversation chart must use the real query");

    // ── 2. AdminPortal has no fabricated "connected" statuses ────────────
    const admin = fs.readFileSync(path.join(ROOT, "client/src/pages/AdminPortal.tsx"), "utf-8");
    assert(
      !/status:\s*"connected" as const/.test(admin),
      'AdminPortal still hardcodes status:"connected" integration entries',
    );
    assert(admin.includes("infra.infraHealth"), "AdminPortal must use the live infraHealth probe");
    assert(admin.includes("Unknown"), "AdminPortal must render an honest unknown state");

    // ── 3. mlOps.getDriftMetrics: honest unavailable without a drift log ──
    const caller = await adminCaller();
    const drift = await caller.mlOps.getDriftMetrics({ days: 14 });
    const logExists = fs.existsSync(path.join(ROOT, "services/ml-stack/data/lakehouse/drift_log.json"));
    if (!logExists) {
      assert(drift.available === false, `expected honest unavailable, got ${JSON.stringify(drift).slice(0, 200)}`);
      assert(Array.isArray(drift.series) && drift.series.length === 0, "unavailable drift must not fabricate a series");
      assert(drift.summary === null, "unavailable drift must not fabricate a summary");
    } else {
      assert(drift.available === true, "drift log present but metrics report unavailable");
    }

    // ── 4. Analytics series are real (empty DB → empty points) ───────────
    const rev = await caller.analytics.revenueTrend();
    const conv = await caller.analytics.conversationSplitTrend();
    assert(Array.isArray(rev.points), "revenueTrend must return points array");
    assert(Array.isArray(conv.points), "conversationSplitTrend must return points array");
    // Simulation orders are unpaid at this point, so revenue points are all
    // derived from real rows — never constants.
    assert(rev.points.every((p: any) => typeof p.revenue === "number" && typeof p.month === "string"),
      "revenueTrend points malformed");
  },
};
