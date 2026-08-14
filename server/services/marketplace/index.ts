/**
 * marketplace/index.ts — integrations marketplace lite (roadmap F7).
 *
 * A deliberately shallow connector layer over the existing Odoo/Twenty/Medusa
 * sync (and the parallel Shopify connector):
 *
 *   listConnectors({ tenantId })   — catalog enriched with per-tenant status
 *                                    (not_installed | configured | error |
 *                                    degraded), health and installUrl.
 *   installConnector(...)          — guided-config state machine: not yet
 *                                    configured → awaiting_config with the
 *                                    required fields; configured → live
 *                                    healthCheck gate, FAIL-CLOSED (a failed
 *                                    probe never activates); success →
 *                                    persisted + audit-logged. Idempotent.
 *   uninstallConnector(...)        — deactivate, preserve the audit trail in
 *                                    state + audit_logs, idempotent, and
 *                                    answer with a data-retention note.
 *   marketplaceHealth({ tenantId })— per-connector health with a 60s
 *                                    per-tenant in-memory cache; NEVER throws
 *                                    (a failing connector becomes an
 *                                    { ok: false } entry).
 *
 * State lives in tenants.settings.marketplace (jsonb — no migration).
 * Credential management stays in each provider's own flow; this layer is
 * read-only over provider config.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import { writeAuditLog } from "../../routers/audit";
import { updateTenantSettings } from "../onboarding";
import { CONNECTOR_CATALOG, getCatalogEntry } from "./catalog";
import { getConnectorDescriptor } from "./connectors";
import type {
  ConnectorHealthEntry,
  ConnectorListing,
  ConnectorStatus,
  InstallResult,
  InstalledConnectorState,
  MarketplaceState,
  UninstallResult,
} from "./types";

export { CONNECTOR_CATALOG, getCatalogEntry } from "./catalog";
export { CONNECTOR_DESCRIPTORS, getConnectorDescriptor } from "./connectors";
export * from "./types";

const HEALTH_CACHE_TTL_MS = 60_000;

export const DATA_RETENTION_NOTE =
  "Connector deactivated. No synced data was deleted: credentials and previously synced records are retained in the connected system and in this workspace. Re-install any time to resume sync.";

// ─── State (tenants.settings.marketplace jsonb) ─────────────────────────────

function readMarketplaceState(settings: Record<string, unknown> | null | undefined): MarketplaceState {
  const raw = (settings as Record<string, any> | null | undefined)?.marketplace as
    | Partial<MarketplaceState>
    | undefined;
  return {
    connectors:
      raw?.connectors && typeof raw.connectors === "object"
        ? { ...(raw.connectors as Record<string, InstalledConnectorState>) }
        : {},
  };
}

async function loadTenantSettings(tenantId: string): Promise<Record<string, unknown>> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  return (tenant.settings ?? {}) as Record<string, unknown>;
}

function activeInstall(state: MarketplaceState, key: string): InstalledConnectorState | null {
  const rec = state.connectors[key];
  return rec?.status === "active" ? rec : null;
}

// ─── Status derivation ───────────────────────────────────────────────────────

function deriveStatus(
  installed: InstalledConnectorState | null,
  configured: boolean,
  health: { ok: boolean; detail?: string } | null,
): ConnectorStatus {
  if (!installed) return "not_installed";
  if (!configured) return "error"; // activated but credentials since removed
  if (!health) return "error";
  if (!health.ok) return "error";
  // Healthy but the probe reported a caveat (e.g. shopify config-presence
  // probe while the connector module has not landed yet).
  return health.detail ? "degraded" : "configured";
}

// ─── listConnectors ──────────────────────────────────────────────────────────

export async function listConnectors(ctx: { tenantId: string }): Promise<ConnectorListing[]> {
  const settings = await loadTenantSettings(ctx.tenantId);
  const state = readMarketplaceState(settings);

  const listings: ConnectorListing[] = [];
  for (const entry of CONNECTOR_CATALOG) {
    const descriptor = getConnectorDescriptor(entry.key);
    const installed = activeInstall(state, entry.key);
    let configured = false;
    let health: { ok: boolean; detail?: string } | null = null;
    let installUrl: string | null = null;
    if (descriptor) {
      configured = await descriptor.isConfigured(ctx.tenantId).catch(() => false);
      // Only probe live systems for installed+configured connectors; the
      // catalog row for an uninstalled connector stays cheap and quiet.
      if (installed && configured) {
        health = await descriptor.healthCheck(ctx.tenantId).catch((err: any) => ({
          ok: false,
          detail: `health check failed: ${err?.message ?? err}`,
        }));
      }
      if (descriptor.installUrl) {
        installUrl = await descriptor.installUrl(ctx.tenantId).catch(() => null);
      }
    }
    listings.push({
      ...entry,
      status: deriveStatus(installed, configured, health),
      health,
      installUrl,
      installedAt: installed?.installedAt ?? null,
    });
  }
  return listings;
}

// ─── installConnector ────────────────────────────────────────────────────────

export async function installConnector(ctx: {
  tenantId: string;
  key: string;
  actorId?: string | null;
  actorRole?: string | null;
}): Promise<InstallResult> {
  const entry = getCatalogEntry(ctx.key);
  const descriptor = getConnectorDescriptor(ctx.key);
  if (!entry || !descriptor) throw new Error(`Unknown connector: ${ctx.key}`);

  const settings = await loadTenantSettings(ctx.tenantId);
  const state = readMarketplaceState(settings);

  // Idempotent: already active → report current state, no duplicate audit.
  const existing = activeInstall(state, ctx.key);
  if (existing) {
    const health = await descriptor.healthCheck(ctx.tenantId).catch((err: any) => ({
      ok: false,
      detail: `health check failed: ${err?.message ?? err}`,
    }));
    return { status: "active", alreadyInstalled: true, health };
  }

  // Guided-config step: credentials live in the provider's own flow.
  const configured = await descriptor.isConfigured(ctx.tenantId).catch(() => false);
  if (!configured) {
    const installUrl = descriptor.installUrl
      ? await descriptor.installUrl(ctx.tenantId).catch(() => null)
      : null;
    return { status: "awaiting_config", requiredFields: entry.requiredConfigFields, installUrl };
  }

  // Fail-closed activation gate: prove the connection before activating.
  const health = await descriptor.healthCheck(ctx.tenantId).catch((err: any) => ({
    ok: false,
    detail: `health check failed: ${err?.message ?? err}`,
  }));
  if (!health.ok) {
    await writeAuditLog({
      actorId: ctx.actorId ?? null,
      actorRole: ctx.actorRole ?? null,
      action: "marketplace.connector.install_failed",
      entityType: "marketplace_connector",
      entityId: ctx.key,
      tenantId: ctx.tenantId,
      summary: `Install of ${entry.name} blocked: health check failed (${health.detail ?? "unknown"})`,
      after: { key: ctx.key, health },
    });
    return { status: "failed", health };
  }

  const installedAt = new Date().toISOString();
  await updateTenantSettings(ctx.tenantId, (s) => {
    const st = readMarketplaceState(s as Record<string, unknown>);
    st.connectors[ctx.key] = {
      status: "active",
      installedAt,
      installedBy: ctx.actorId ?? null,
    };
    (s as Record<string, unknown>).marketplace = st;
  });
  await writeAuditLog({
    actorId: ctx.actorId ?? null,
    actorRole: ctx.actorRole ?? null,
    action: "marketplace.connector.install",
    entityType: "marketplace_connector",
    entityId: ctx.key,
    tenantId: ctx.tenantId,
    summary: `Installed connector ${entry.name}`,
    after: { key: ctx.key, installedAt, health },
  });
  clearHealthCache(ctx.tenantId, ctx.key);
  return { status: "active", health };
}

// ─── uninstallConnector ──────────────────────────────────────────────────────

export async function uninstallConnector(ctx: {
  tenantId: string;
  key: string;
  actorId?: string | null;
  actorRole?: string | null;
}): Promise<UninstallResult> {
  const entry = getCatalogEntry(ctx.key);
  if (!entry) throw new Error(`Unknown connector: ${ctx.key}`);

  const settings = await loadTenantSettings(ctx.tenantId);
  const state = readMarketplaceState(settings);
  const existing = activeInstall(state, ctx.key);

  // Idempotent: never installed (or already uninstalled) → quiet no-op.
  if (!existing) {
    return { status: "not_installed", alreadyUninstalled: true, dataRetention: DATA_RETENTION_NOTE };
  }

  const uninstalledAt = new Date().toISOString();
  await updateTenantSettings(ctx.tenantId, (s) => {
    const st = readMarketplaceState(s as Record<string, unknown>);
    const prev = st.connectors[ctx.key];
    // Preserve the full record (audit trail) — only flip the status.
    st.connectors[ctx.key] = {
      ...prev,
      status: "uninstalled",
      uninstalledAt,
      uninstalledBy: ctx.actorId ?? null,
    };
    (s as Record<string, unknown>).marketplace = st;
  });
  await writeAuditLog({
    actorId: ctx.actorId ?? null,
    actorRole: ctx.actorRole ?? null,
    action: "marketplace.connector.uninstall",
    entityType: "marketplace_connector",
    entityId: ctx.key,
    tenantId: ctx.tenantId,
    summary: `Uninstalled connector ${entry.name} (synced data retained)`,
    before: { key: ctx.key, status: "active", installedAt: existing.installedAt },
    after: { key: ctx.key, status: "uninstalled", uninstalledAt },
  });
  clearHealthCache(ctx.tenantId, ctx.key);
  return { status: "uninstalled", dataRetention: DATA_RETENTION_NOTE };
}

// ─── marketplaceHealth (cached aggregation, never throws) ────────────────────

const healthCache = new Map<string, { at: number; value: ConnectorHealthEntry }>();

function cacheKey(tenantId: string, key: string) {
  return `${tenantId}:${key}`;
}

/** Test hook + cache invalidation on install/uninstall. */
export function clearHealthCache(tenantId?: string, key?: string): void {
  if (!tenantId) {
    healthCache.clear();
    return;
  }
  if (key) {
    healthCache.delete(cacheKey(tenantId, key));
    return;
  }
  for (const k of Array.from(healthCache.keys())) {
    if (k.startsWith(`${tenantId}:`)) healthCache.delete(k);
  }
}

async function probeConnector(
  tenantId: string,
  entry: (typeof CONNECTOR_CATALOG)[number],
  installed: boolean,
): Promise<ConnectorHealthEntry> {
  const key = cacheKey(tenantId, entry.key);
  const hit = healthCache.get(key);
  if (hit && Date.now() - hit.at < HEALTH_CACHE_TTL_MS) {
    return { ...hit.value, cached: true };
  }
  const descriptor = getConnectorDescriptor(entry.key);
  let configured = false;
  let health: { ok: boolean; detail?: string } = { ok: false, detail: "no descriptor registered" };
  if (descriptor) {
    configured = await descriptor.isConfigured(tenantId).catch(() => false);
    health = await descriptor.healthCheck(tenantId).catch((err: any) => ({
      ok: false,
      detail: `health check failed: ${err?.message ?? err}`,
    }));
  }
  const value: ConnectorHealthEntry = {
    key: entry.key,
    name: entry.name,
    category: entry.category,
    installed,
    configured,
    health,
    cached: false,
  };
  healthCache.set(key, { at: Date.now(), value });
  return value;
}

export async function marketplaceHealth(ctx: { tenantId: string }): Promise<{
  tenantId: string;
  connectors: ConnectorHealthEntry[];
}> {
  // Never throws: per-connector isolation means one failing connector (or a
  // failing settings read) degrades to { ok: false } entries, not a 500.
  let state: MarketplaceState = { connectors: {} };
  try {
    state = readMarketplaceState(await loadTenantSettings(ctx.tenantId));
  } catch {
    /* fall through with empty state */
  }
  const connectors = await Promise.all(
    CONNECTOR_CATALOG.map((entry) =>
      probeConnector(ctx.tenantId, entry, activeInstall(state, entry.key) !== null).catch(
        (err: any): ConnectorHealthEntry => ({
          key: entry.key,
          name: entry.name,
          category: entry.category,
          installed: false,
          configured: false,
          health: { ok: false, detail: `health probe failed: ${err?.message ?? err}` },
          cached: false,
        }),
      ),
    ),
  );
  return { tenantId: ctx.tenantId, connectors };
}
