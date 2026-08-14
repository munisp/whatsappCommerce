/**
 * marketplace/types.ts — frozen connector seam + catalog/state types for the
 * integrations marketplace lite (roadmap F7).
 *
 * Deliberately shallow: a listing-grade connector layer (registry,
 * install/uninstall, health) over the existing Odoo/Twenty/Medusa sync and
 * the Shopify connector. No credential management lives here — each provider
 * keeps its own authoritative config flow; the marketplace only observes it.
 */

/** Frozen seam every connector descriptor follows (shared with C1). */
export interface ConnectorDescriptor {
  key: string; // 'odoo' | 'twenty' | 'medusa' | 'shopify'
  name: string;
  category: "erp" | "crm" | "storefront" | "payments" | "channel";
  logoKey: string;
  isConfigured(tenantId: string): Promise<boolean>;
  healthCheck(tenantId: string): Promise<{ ok: boolean; detail?: string }>;
  installUrl?(tenantId: string): Promise<string | null>;
  capabilities: string[];
}

export type ConnectorCategory = ConnectorDescriptor["category"];

export const CONNECTOR_CATEGORIES: readonly ConnectorCategory[] = [
  "erp",
  "crm",
  "storefront",
  "payments",
  "channel",
] as const;

/** Per-tenant listing status derived from install state + live config/health. */
export type ConnectorStatus = "not_installed" | "configured" | "error" | "degraded";

/** Static marketing metadata shown in the catalog (no runtime behaviour). */
export interface CatalogEntry {
  key: string;
  name: string;
  tagline: string;
  category: ConnectorCategory;
  logoKey: string;
  /** Human setup expectation, e.g. "10 min". */
  setupTime: string;
  capabilities: string[];
  /**
   * Credential fields the operator must complete in the provider's own
   * config flow before install can activate (install is fail-closed).
   */
  requiredConfigFields: string[];
}

/** Catalog entry enriched with per-tenant runtime status. */
export interface ConnectorListing extends CatalogEntry {
  status: ConnectorStatus;
  health: { ok: boolean; detail?: string } | null;
  installUrl: string | null;
  installedAt: string | null;
}

/** Persisted install record (tenants.settings.marketplace.connectors.<key>). */
export interface InstalledConnectorState {
  status: "active" | "uninstalled";
  installedAt: string;
  installedBy: string | null;
  uninstalledAt?: string | null;
  uninstalledBy?: string | null;
}

export interface MarketplaceState {
  connectors: Record<string, InstalledConnectorState>;
}

export type InstallResult =
  | { status: "active"; alreadyInstalled?: boolean; health: { ok: boolean; detail?: string } }
  | { status: "awaiting_config"; requiredFields: string[]; installUrl: string | null }
  | { status: "failed"; health: { ok: boolean; detail?: string } };

export interface UninstallResult {
  status: "uninstalled" | "not_installed";
  alreadyUninstalled?: boolean;
  dataRetention: string;
}

export interface ConnectorHealthEntry {
  key: string;
  name: string;
  category: ConnectorCategory;
  installed: boolean;
  configured: boolean;
  health: { ok: boolean; detail?: string };
  /** true when served from the 60s in-memory cache. */
  cached: boolean;
}
