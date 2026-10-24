/**
 * === W34 otel-sidecars (Coder C) — telemetry admin router ===
 *
 * Platform-admin operations for the tenant metric cardinality guard:
 *   - getStatus: honest telemetry status (enabled / exporter reachability /
 *     allowlist sizes). Fail-open — never throws on collector outages.
 *   - setTenantAllowlist: replace the persisted per-tenant metric allowlist
 *     (telemetry_tenant_allowlist, migration 0115). Audited via
 *     `telemetry.allowlist.set` audit rows with before/after snapshots.
 *
 * Both procedures are adminProcedure (platform-admin only). Tenants NOT in
 * the allowlist collapse to tenant_class="other" on /api/metrics — this
 * bounds Prometheus label cardinality (J221).
 */
import { z } from "zod";
import { adminProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  getTelemetryStatus,
  setPersistedAllowlist,
  tenantMetricClass,
  getEffectiveAllowlist,
} from "../services/telemetryCardinality";
// === W64 intelligence (R5) ===
import { sql } from "drizzle-orm";
import { uiEvents } from "../../drizzle/schema";
// === END W64 intelligence (R5) ===

export const telemetryRouter = router({
  /** Honest telemetry status + effective allowlist (admin only). */
  getStatus: adminProcedure.query(async () => {
    const db = await getDb();
    return getTelemetryStatus(db ?? null);
  }),

  /** Replace the persisted allowlist. Audited. */
  setTenantAllowlist: adminProcedure
    .input(z.object({
      tenantIds: z.array(z.string().min(1).max(36)).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const effective = await setPersistedAllowlist(
        db, input.tenantIds, `admin:${ctx.user.id}`,
      );
      return { success: true as const, allowlist: effective, count: effective.length };
    }),

  /** Preview the label class a tenant would get (admin only; debugging). */
  tenantClass: adminProcedure
    .input(z.object({ tenantId: z.string().min(1).max(36) }))
    .query(async ({ input }) => {
      const db = await getDb();
      const allowlist = await getEffectiveAllowlist(db ?? null);
      return { tenantId: input.tenantId, tenantClass: tenantMetricClass(input.tenantId, allowlist) };
    }),

  // === W64 intelligence (R5) ===
  /**
   * Clickstream capture beacon — batched, fire-and-forget, FAIL-OPEN.
   * Public (the storefront is unauthenticated); userId is attached from the
   * session when present. Bounded batches (≤50 events) with clamped field
   * sizes; inserts are sequential (PGlite-safe). Never throws — telemetry
   * must not break UX.
   */
  captureEvent: publicProcedure
    .input(z.object({
      events: z.array(z.object({
        tenantId: z.string().max(36).nullish(),
        sessionId: z.string().max(64).nullish(),
        app: z.string().max(32).nullish(),
        page: z.string().min(1).max(255),
        action: z.string().min(1).max(64),
        dwellMs: z.number().int().min(0).max(3_600_000).nullish(),
        metadata: z.record(z.string(), z.unknown()).nullish(),
      })).min(1).max(50),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { captured: 0 };
      let captured = 0;
      const userId = (ctx as { user?: { id?: number | string } }).user?.id;
      for (const e of input.events) {
        const ok = await db.insert(uiEvents).values({
          tenantId: e.tenantId ?? null,
          userId: userId != null ? String(userId) : null,
          sessionId: e.sessionId ?? null,
          app: e.app ?? null,
          page: e.page.slice(0, 255),
          action: e.action.slice(0, 64),
          dwellMs: e.dwellMs ?? null,
          metadata: e.metadata ?? null,
        }).then(() => true).catch(() => false);
        if (ok) captured += 1;
      }
      return { captured };
    }),

  /**
   * Platform-admin friction dashboard data: top abandonment pages (most
   * 'abandon' actions + avg dwell) and top zero-result searches, 30-day
   * window. Fail-open → empty arrays on any error.
   */
  frictionSummary: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { abandonment: [], zeroResultSearches: [] };
    try {
      const abandonment = await db.execute(sql`
        SELECT page, COUNT(*)::int AS abandons,
               COALESCE(AVG(dwell_ms), 0)::int AS avg_dwell_ms
        FROM ui_events
        WHERE action = 'abandon' AND created_at > now() - interval '30 days'
        GROUP BY page ORDER BY abandons DESC LIMIT 10
      `).then((r: any) => (r.rows ?? r)).catch(() => []);
      const zeroResultSearches = await db.execute(sql`
        SELECT query, COUNT(*)::int AS occurrences
        FROM search_queries
        WHERE zero_result AND created_at > now() - interval '30 days'
        GROUP BY query ORDER BY occurrences DESC LIMIT 10
      `).then((r: any) => (r.rows ?? r)).catch(() => []);
      return { abandonment, zeroResultSearches };
    } catch {
      return { abandonment: [], zeroResultSearches: [] };
    }
  }),
  // === END W64 intelligence (R5) ===
});
// === END W34 otel-sidecars ===
