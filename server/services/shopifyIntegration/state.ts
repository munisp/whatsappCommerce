/**
 * shopifyIntegration/state.ts — connection + sync state persistence.
 *
 * NO migration: everything lives in tenants.settings.shopifyIntegration
 * (jsonb). The access token is stored ENCRYPTED (crypto/secrets
 * encryptSecret) and is never written to logs or audit rows.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import { updateTenantSettings } from "../onboarding";
import { encryptSecret, decryptSecret } from "../crypto/secrets";
import type { TenantSettings } from "../../../shared/tenantConfig";
import type { ShopifyConnection } from "./client";

export interface ShopifySyncItemResult {
  sku: string;
  action: "created" | "updated" | "adopted" | "failed" | "skipped";
  externalId?: string;
  error?: string;
}

export interface ShopifyIntegrationState {
  /** OAuth connection. accessTokenEncrypted is enc2:<...> — never decrypt for logs. */
  connection: {
    shop: string;
    accessTokenEncrypted: string;
    scope: string;
    installedAt: string;
  } | null;
  /** In-flight OAuth nonce (10-minute validity), cleared on success. */
  pendingOAuth: { nonce: string; createdAt: string } | null;
  /** Catalog sync state: sku → Shopify product id mapping + last summary. */
  catalog: {
    externalIds: Record<string, string>;
    lastSyncAt: string | null;
    lastResults: {
      created: number;
      updated: number;
      failed: number;
      items: ShopifySyncItemResult[];
    } | null;
  };
  /** Order bridge dedupe: Shopify order id → platform order id (capped). */
  orders: {
    processedIds: Record<string, string>;
    lastOrderAt: string | null;
  };
}

const ORDER_DEDUPE_CAP = 500;

export function emptyShopifyState(): ShopifyIntegrationState {
  return {
    connection: null,
    pendingOAuth: null,
    catalog: { externalIds: {}, lastSyncAt: null, lastResults: null },
    orders: { processedIds: {}, lastOrderAt: null },
  };
}

export function readShopifyState(settings: TenantSettings): ShopifyIntegrationState {
  const raw = (settings as Record<string, unknown>).shopifyIntegration as
    | Partial<ShopifyIntegrationState>
    | undefined;
  const base = emptyShopifyState();
  if (!raw || typeof raw !== "object") return base;
  return {
    connection:
      raw.connection && typeof raw.connection === "object" && raw.connection.shop
        ? { ...raw.connection } as ShopifyIntegrationState["connection"]
        : null,
    pendingOAuth:
      raw.pendingOAuth && typeof raw.pendingOAuth === "object"
        ? { ...(raw.pendingOAuth as ShopifyIntegrationState["pendingOAuth"] & object) }
        : null,
    catalog: {
      externalIds:
        raw.catalog?.externalIds && typeof raw.catalog.externalIds === "object"
          ? { ...raw.catalog.externalIds }
          : {},
      lastSyncAt: typeof raw.catalog?.lastSyncAt === "string" ? raw.catalog.lastSyncAt : null,
      lastResults: raw.catalog?.lastResults ? { ...(raw.catalog.lastResults as any) } : null,
    },
    orders: {
      processedIds:
        raw.orders?.processedIds && typeof raw.orders.processedIds === "object"
          ? { ...raw.orders.processedIds }
          : {},
      lastOrderAt: typeof raw.orders?.lastOrderAt === "string" ? raw.orders.lastOrderAt : null,
    },
  };
}

/** Load tenant row + parsed settings. Throws when tenant is missing. */
export async function loadTenantSettings(tenantId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [tenant] = await db
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  const settings = (tenant.settings ?? {}) as TenantSettings;
  return { db, tenant, settings };
}

/** Atomically mutate settings.shopifyIntegration and persist. */
export async function updateShopifyState(
  tenantId: string,
  mutate: (state: ShopifyIntegrationState) => void,
): Promise<ShopifyIntegrationState> {
  let next: ShopifyIntegrationState = emptyShopifyState();
  await updateTenantSettings(tenantId, (settings) => {
    const state = readShopifyState(settings);
    mutate(state);
    // Cap the dedupe map: drop oldest-inserted keys beyond the cap.
    const ids = Object.keys(state.orders.processedIds);
    if (ids.length > ORDER_DEDUPE_CAP) {
      for (const k of ids.slice(0, ids.length - ORDER_DEDUPE_CAP)) {
        delete state.orders.processedIds[k];
      }
    }
    (settings as Record<string, unknown>).shopifyIntegration = state;
    next = state;
  });
  return next;
}

/** Resolve the live connection (decrypted token) or null. Never throws on bad state. */
export async function getShopifyConnection(tenantId: string): Promise<ShopifyConnection | null> {
  try {
    const { settings } = await loadTenantSettings(tenantId);
    const conn = readShopifyState(settings).connection;
    if (!conn?.shop || !conn.accessTokenEncrypted) return null;
    return { shop: conn.shop, accessToken: decryptSecret(conn.accessTokenEncrypted) };
  } catch {
    return null;
  }
}

export function encryptToken(accessToken: string): string {
  return encryptSecret(accessToken);
}
