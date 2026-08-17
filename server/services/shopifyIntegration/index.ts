/**
 * shopifyIntegration/index.ts — Shopify app connector (roadmap F7).
 *
 * FROZEN SEAM: the marketplace integration registry (C3) consumes the
 * `ConnectorDescriptor` exported here — do not change its shape.
 *
 * Capabilities: oauth install, catalog_sync_out (platform → Shopify),
 * order_bridge_in (Shopify orders/create → platform orders), HMAC-verified
 * webhooks. All state lives in tenants.settings.shopifyIntegration (jsonb —
 * no migration).
 */
import { ENV } from "../../_core/env";
import { shopifyApi } from "./client";
import { getShopifyConnection, loadTenantSettings, readShopifyState } from "./state";
import { buildInstallUrl, isShopifyAppConfigured } from "./oauth";

export * from "./security";
export * from "./client";
export * from "./state";
export {
  buildInstallUrl,
  handleOAuthCallback,
  uninstallShopify,
  isShopifyAppConfigured,
  shopifyRedirectUri,
} from "./oauth";
export { syncCatalogToShopify, type CatalogSyncSummary } from "./catalogSync";
export {
  bridgeShopifyOrder,
  toKobo,
  type OrderBridgeResult,
  type ShopifyOrderPayload,
} from "./orderBridge";

// ─── Frozen seam: ConnectorDescriptor (consumed by the marketplace registry) ─

export interface ConnectorDescriptor {
  key: "shopify";
  name: "Shopify";
  category: "storefront";
  logoKey: "shopify";
  isConfigured(tenantId: string): Promise<boolean>;
  healthCheck(tenantId: string): Promise<{ ok: boolean; detail?: string }>;
  installUrl?(tenantId: string): Promise<string | null>;
  capabilities: ["catalog_sync_out", "order_bridge_in", "oauth"];
}

export const shopifyConnector: ConnectorDescriptor = {
  key: "shopify",
  name: "Shopify",
  category: "storefront",
  logoKey: "shopify",
  capabilities: ["catalog_sync_out", "order_bridge_in", "oauth"],

  /** True when the tenant has completed OAuth (app creds + stored token). */
  async isConfigured(tenantId: string): Promise<boolean> {
    if (!isShopifyAppConfigured()) return false;
    return (await getShopifyConnection(tenantId)) !== null;
  },

  /**
   * Live connectivity check against the shop. Never throws; honest detail
   * strings (token redacted).
   */
  async healthCheck(tenantId: string): Promise<{ ok: boolean; detail?: string }> {
    if (!isShopifyAppConfigured()) {
      return { ok: false, detail: "shopify app credentials not configured" };
    }
    const conn = await getShopifyConnection(tenantId);
    if (!conn) return { ok: false, detail: "not connected" };
    const res = await shopifyApi(conn, "GET", "/shop.json?fields=id,name,myshopify_domain");
    if (res.ok) return { ok: true, detail: `connected to ${conn.shop}` };
    return { ok: false, detail: res.error };
  },

  /** OAuth install URL (null when app credentials are unset). */
  async installUrl(tenantId: string): Promise<string | null> {
    return buildInstallUrl(tenantId);
  },
};

/** Status payload for the router (no secrets). */
export async function getShopifyStatus(tenantId: string) {
  const { settings } = await loadTenantSettings(tenantId);
  const state = readShopifyState(settings);
  return {
    appConfigured: isShopifyAppConfigured(),
    apiVersion: ENV.shopifyApiVersion,
    scopes: ENV.shopifyScopes.split(",").map((s) => s.trim()).filter(Boolean),
    connected: state.connection !== null,
    shop: state.connection?.shop ?? null,
    installedAt: state.connection?.installedAt ?? null,
    catalog: {
      mappedProducts: Object.keys(state.catalog.externalIds).length,
      lastSyncAt: state.catalog.lastSyncAt,
      lastResults: state.catalog.lastResults
        ? {
            created: state.catalog.lastResults.created,
            updated: state.catalog.lastResults.updated,
            failed: state.catalog.lastResults.failed,
          }
        : null,
    },
    orders: {
      bridgedCount: Object.keys(state.orders.processedIds).length,
      lastOrderAt: state.orders.lastOrderAt,
    },
  };
}
