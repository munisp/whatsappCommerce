// === W64 intelligence ===
/**
 * J620 — R5 clickstream + friction dashboard:
 *   1. telemetry.captureEvent (public beacon) inserts ui_events rows
 *      (batched, fail-open, never throws).
 *   2. logSearchQuery records a zero-result search in search_queries.
 *   3. telemetry.frictionSummary (admin) aggregates BOTH: abandonment by
 *      page (count + avg dwell) and top zero-result searches.
 */
import { assert, type World, TENANT_ID } from "../world";
import { adminCaller, publicCaller } from "./helpers";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J620",
  name: "clickstream: captureEvent inserts, zero-result search log, frictionSummary aggregates",
  feature: "W64 intelligence R5: telemetry capture + friction summary",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { logSearchQuery } = await import("../../server/routers/search");
    const { eq } = await import("drizzle-orm");
    const PAGE = "/j620/checkout";
    const QUERY = "j620 no such product xyz";
    try {
      // ── 1. Public capture beacon (unauthenticated, batched) ────────────
      const pub = await publicCaller();
      const res = await pub.telemetry.captureEvent({
        events: [
          { tenantId: TENANT_ID, sessionId: "s-j620-1", app: "web", page: PAGE, action: "view", dwellMs: 1000 },
          { tenantId: TENANT_ID, sessionId: "s-j620-1", app: "web", page: PAGE, action: "abandon", dwellMs: 2000 },
          { tenantId: TENANT_ID, sessionId: "s-j620-2", app: "web", page: PAGE, action: "abandon", dwellMs: 4000 },
        ],
      });
      assert(res.captured === 3, `3 events captured (got ${JSON.stringify(res)})`);
      const rows = await world.db.select().from(schema.uiEvents).where(eq(schema.uiEvents.page, PAGE));
      assert(rows.length === 3, `ui_events rows persisted (got ${rows.length})`);

      // ── 2. Zero-result search log (fire-and-forget is awaitable here) ──
      await logSearchQuery({ tenantId: TENANT_ID, userId: "j620", channel: "web", query: QUERY, resultsCount: 0 });
      await logSearchQuery({ tenantId: TENANT_ID, userId: "j620", channel: "web", query: QUERY, resultsCount: 0 });
      await logSearchQuery({ tenantId: TENANT_ID, userId: "j620", channel: "web", query: "j620 rice", resultsCount: 3 });
      const logged = await world.db.select().from(schema.searchQueries).where(eq(schema.searchQueries.query, QUERY));
      assert(logged.length === 2 && logged.every((r: any) => r.zeroResult), `zero-result rows flagged (got ${logged.length})`);

      // ── 3. Admin friction summary aggregates correctly ─────────────────
      const admin = await adminCaller();
      const summary = await admin.telemetry.frictionSummary();
      const ab = (summary.abandonment as any[]).find((r) => r.page === PAGE);
      assert(ab, `abandonment row for ${PAGE} (got ${JSON.stringify(summary.abandonment)})`);
      assert(ab.abandons === 2, `2 abandons (got ${ab.abandons})`);
      assert(ab.avg_dwell_ms === 3000, `avg dwell 3000ms (got ${ab.avg_dwell_ms})`);
      const zs = (summary.zeroResultSearches as any[]).find((r) => r.query === QUERY);
      assert(zs && zs.occurrences === 2, `zero-result query aggregated (got ${JSON.stringify(summary.zeroResultSearches)})`);
      assert(!(summary.zeroResultSearches as any[]).some((r) => r.query === "j620 rice"), "non-zero-result search excluded");
    } finally {
      await world.db.delete(schema.uiEvents).where(eq(schema.uiEvents.page, PAGE)).catch(() => {});
      await world.db.execute(`DELETE FROM search_queries WHERE query LIKE 'j620%'`).catch(() => {});
    }
  },
};
