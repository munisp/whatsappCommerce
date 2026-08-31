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
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  getTelemetryStatus,
  setPersistedAllowlist,
  tenantMetricClass,
  getEffectiveAllowlist,
} from "../services/telemetryCardinality";

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
});
// === END W34 otel-sidecars ===
