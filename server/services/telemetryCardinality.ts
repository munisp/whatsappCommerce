/**
 * === W34 otel-sidecars (Coder C) — tenant metric cardinality guard ===
 *
 * Bounds the per-tenant label cardinality of /api/metrics (Prometheus):
 * `tenantMetricClass(tenantId)` returns the tenantId verbatim ONLY for
 * allowlisted tenants; every other tenant collapses to the single label
 * value "other". This keeps label cardinality ≤ allowlist size + 1 no
 * matter how many tenants the platform has (J221).
 *
 * Allowlist sources (union):
 *   1. Env CSV `OTEL_TENANT_METRIC_ALLOWLIST` (Coder A's config surface).
 *   2. The persisted `telemetry_tenant_allowlist` table (migration 0115),
 *      managed via the admin-only `telemetry.setTenantAllowlist` mutation.
 *
 * Fail-open doctrine: if the table is missing (migration not applied yet)
 * or the DB is down, the guard degrades to the env-only allowlist and never
 * throws into the metrics path.
 */
import { eq } from "drizzle-orm";
import { auditLogs, telemetryTenantAllowlist } from "../../drizzle/schema";

type Db = any;

/** Label value used for every non-allowlisted tenant. */
export const TENANT_CLASS_OTHER = "other";

/** Parse the OTEL_TENANT_METRIC_ALLOWLIST CSV env var (empty → none). */
export function envAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const csv = env.OTEL_TENANT_METRIC_ALLOWLIST ?? "";
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Map a tenant id to its metric label class. Pure: the caller passes the
 * effective allowlist (env ∪ DB). An empty allowlist means EVERYTHING
 * collapses to "other" (platform-aggregate only) — the documented default.
 */
export function tenantMetricClass(
  tenantId: string | null | undefined,
  allowlist: readonly string[] = envAllowlist(),
): string {
  if (!tenantId) return TENANT_CLASS_OTHER;
  return allowlist.includes(tenantId) ? tenantId : TENANT_CLASS_OTHER;
}

/** Persisted allowlist rows. Fail-open: missing table / DB error → []. */
export async function getPersistedAllowlist(db: Db): Promise<string[]> {
  try {
    const rows = await db
      .select({ tenantId: telemetryTenantAllowlist.tenantId })
      .from(telemetryTenantAllowlist);
    return rows.map((r: { tenantId: string }) => r.tenantId);
  } catch {
    return []; // table not migrated yet — env-only mode
  }
}

/** Effective allowlist: env CSV ∪ persisted table (deduped, sorted). */
export async function getEffectiveAllowlist(db: Db | null): Promise<string[]> {
  const persisted = db ? await getPersistedAllowlist(db) : [];
  return Array.from(new Set([...envAllowlist(), ...persisted])).sort();
}

/** DB-backed variant for hot paths that already hold a db handle. */
export async function tenantMetricClassDb(db: Db, tenantId: string | null | undefined): Promise<string> {
  return tenantMetricClass(tenantId, await getEffectiveAllowlist(db));
}

/**
 * Replace the persisted allowlist (admin op). Audited: one audit_logs row
 * per call (`telemetry.allowlist.set`) with before/after snapshots. Env CSV
 * entries are NOT touched — they are operator config, not mutable state.
 */
export async function setPersistedAllowlist(db: Db, tenantIds: string[], addedBy: string): Promise<string[]> {
  const unique = Array.from(new Set(tenantIds.map((t) => t.trim()).filter(Boolean))).sort();
  const before = await getPersistedAllowlist(db);
  if (before.length) {
    await db.delete(telemetryTenantAllowlist);
  }
  for (const tenantId of unique) {
    await db.insert(telemetryTenantAllowlist)
      .values({ tenantId, addedBy })
      .onConflictDoNothing();
  }
  await db.insert(auditLogs).values({
    actorId: addedBy,
    actorRole: "admin",
    action: "telemetry.allowlist.set",
    entityType: "telemetry_tenant_allowlist",
    entityId: null,
    tenantId: null,
    summary: `Telemetry tenant metric allowlist set to [${unique.join(", ")}] (${unique.length} tenants)`,
    before: { tenantIds: before },
    after: { tenantIds: unique },
  });
  // === W34 merger seam === keep the metric-label cache in sync immediately.
  persistedCache = unique;
  cacheLoadedAt = Date.now();
  return unique;
}

// === W34 merger seam (otel-core ↔ otel-sidecars) ===
// Wire the persisted allowlist into Coder A's /api/metrics label guard
// (server/_core/telemetry.tenantAllowlist). Sync provider over a small cache
// (refreshed on admin writes + lazily every 60s); env CSV is UNIONED in, so
// operator config and admin state both count. Fail-open: any failure → null
// → _core/telemetry falls back to env CSV only.
let persistedCache: string[] | null = null;
let cacheLoadedAt = 0;
let refreshInFlight: Promise<void> | null = null;

async function refreshPersistedCache(): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    persistedCache = db ? await getPersistedAllowlist(db) : [];
    cacheLoadedAt = Date.now();
  } catch {
    // keep previous cache; env-only when never loaded
  }
}

/** Sync provider for _core/telemetry: env CSV ∪ persisted (null = not loaded yet). */
export function metricAllowlistProvider(): readonly string[] | null {
  if (persistedCache === null || Date.now() - cacheLoadedAt > 60_000) {
    if (!refreshInFlight) {
      refreshInFlight = refreshPersistedCache().finally(() => { refreshInFlight = null; });
    }
    if (persistedCache === null) return null;
  }
  return Array.from(new Set([...envAllowlist(), ...(persistedCache ?? [])])).sort();
}

/** Register the provider with _core/telemetry (called once at server boot). */
export async function registerMetricAllowlistProvider(): Promise<void> {
  try {
    const mod: any = await import("../_core/telemetry");
    mod.setTenantAllowlistProvider?.(metricAllowlistProvider);
  } catch {
    // fail-open: telemetry module absent → env-only labels
  }
}
// === END W34 merger seam ===

/**
 * Honest telemetry status for the admin `telemetry.getStatus` procedure:
 * enabled flag, exporter state (from Coder A's telemetry module when
 * present), collector reachability probe, and allowlist sizes. Never throws.
 */
export async function getTelemetryStatus(db: Db | null): Promise<{
  enabled: boolean;
  exporter: { configured: boolean; endpoint: string | null; reachable: boolean | null; lastError: string | null };
  allowlist: { envCount: number; persistedCount: number; effectiveCount: number; effective: string[] };
}> {
  const enabled = (process.env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
  const endpoint = enabled
    ? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector:4318").replace(/\/$/, "")
    : null;

  // Coder A's server/_core/telemetry.ts (w34/otel-core) — merged later.
  // Lazy import + fallback so this branch is honest standalone.
  let lastError: string | null = null;
  try {
    // Non-literal specifier: A's module lands at merge time; tsc on this
    // branch must not require it.
    const telemetryModulePath = "../_core/telemetry";
    const mod: any = await import(telemetryModulePath);
    const st = mod.telemetryStatus?.();
    if (st?.lastError) lastError = String(st.lastError);
  } catch {
    lastError = lastError ?? null; // module absent on this branch — not an error
  }

  // Collector reachability probe (only when enabled; short timeout, fail-open).
  let reachable: boolean | null = null;
  if (enabled && endpoint) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      // POST an empty OTLP payload: any HTTP response proves reachability.
      const res = await fetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      clearTimeout(timer);
      reachable = res.status < 500;
    } catch (err) {
      reachable = false;
      lastError = (err as Error)?.message ?? String(err);
    }
  }

  const envList = envAllowlist();
  const persisted = db ? await getPersistedAllowlist(db) : [];
  const effective = Array.from(new Set([...envList, ...persisted])).sort();
  return {
    enabled,
    exporter: { configured: enabled, endpoint, reachable, lastError },
    allowlist: {
      envCount: envList.length,
      persistedCount: persisted.length,
      effectiveCount: effective.length,
      effective,
    },
  };
}
// === END W34 otel-sidecars ===
