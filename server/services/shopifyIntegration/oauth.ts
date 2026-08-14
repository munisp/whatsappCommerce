/**
 * shopifyIntegration/oauth.ts — Shopify app OAuth install/callback/uninstall
 * (roadmap F7).
 *
 * Flow:
 *   1. buildInstallUrl(tenantId) — mints a signed state nonce
 *      (`<tenantId>.<nonce>.<hmac>`), persists the nonce in tenant settings
 *      (10-minute validity), returns the Shopify authorize URL.
 *   2. handleOAuthCallback({ shop, code, state }) — verifies the signed
 *      state + nonce, exchanges code → access token (injectable fetch, 8s,
 *      redacted errors), persists the ENCRYPTED token.
 *   3. uninstallShopify(tenantId) — best-effort token revocation at Shopify,
 *      then clears the connection + OAuth state.
 *
 * CSRF: the state parameter binds the redirect to the tenant + a one-time
 * server-side nonce signed with SHOPIFY_API_SECRET — a forged callback
 * without the matching persisted nonce is rejected.
 */
import crypto from "crypto";
import { ENV } from "../../_core/env";
import { writeAuditLog } from "../../routers/audit";
import { exchangeOAuthCode, revokeAccessToken } from "./client";
import { signOAuthState, verifyOAuthState, redactShopifySecrets } from "./security";
import {
  readShopifyState,
  updateShopifyState,
  loadTenantSettings,
  encryptToken,
  getShopifyConnection,
} from "./state";

const NONCE_TTL_MS = 10 * 60 * 1000;

export function isShopifyAppConfigured(): boolean {
  return Boolean(ENV.shopifyApiKey && ENV.shopifyApiSecret && ENV.shopifyAppUrl);
}

export function shopifyRedirectUri(): string {
  return `${ENV.shopifyAppUrl.replace(/\/+$/, "")}/api/shopify/callback`;
}

/**
 * Build the Shopify OAuth authorize URL for a tenant. Returns null when the
 * app-level credentials are not configured.
 */
export async function buildInstallUrl(
  tenantId: string,
  opts: { shop?: string } = {},
): Promise<string | null> {
  if (!isShopifyAppConfigured()) return null;
  // Validate the tenant exists before minting a nonce.
  await loadTenantSettings(tenantId);
  const nonce = crypto.randomUUID();
  await updateShopifyState(tenantId, (state) => {
    state.pendingOAuth = { nonce, createdAt: new Date().toISOString() };
  });
  const payload = `${tenantId}.${nonce}`;
  const state = `${payload}.${signOAuthState(payload, ENV.shopifyApiSecret)}`;
  const params = new URLSearchParams({
    client_id: ENV.shopifyApiKey,
    scope: ENV.shopifyScopes,
    redirect_uri: shopifyRedirectUri(),
    state,
  });
  const shop = opts.shop?.trim() || "{shop}.myshopify.com";
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

export type OAuthCallbackResult =
  | { ok: true; tenantId: string; shop: string; scope: string }
  | { ok: false; error: string };

/**
 * Handle the OAuth redirect callback. Verifies the signed state, checks the
 * persisted one-time nonce, exchanges the code, persists the encrypted token.
 */
export async function handleOAuthCallback(input: {
  shop: string;
  code: string;
  state: string;
}): Promise<OAuthCallbackResult> {
  if (!isShopifyAppConfigured()) return { ok: false, error: "shopify app not configured" };
  const shop = input.shop?.trim();
  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return { ok: false, error: "invalid shop domain" };
  }
  // state = "<tenantId>.<nonce>.<hmac>"
  const parts = input.state.split(".");
  if (parts.length < 3) return { ok: false, error: "malformed state" };
  const signature = parts.pop()!;
  const nonce = parts.pop()!;
  const tenantId = parts.join(".");
  const payload = `${tenantId}.${nonce}`;
  if (!verifyOAuthState(payload, signature, ENV.shopifyApiSecret)) {
    return { ok: false, error: "invalid state signature" };
  }
  let tenantSettings;
  try {
    tenantSettings = await loadTenantSettings(tenantId);
  } catch {
    return { ok: false, error: "tenant not found" };
  }
  const pending = readShopifyState(tenantSettings.settings).pendingOAuth;
  if (!pending || pending.nonce !== nonce) {
    return { ok: false, error: "unknown or already-used oauth nonce" };
  }
  if (Date.now() - new Date(pending.createdAt).getTime() > NONCE_TTL_MS) {
    return { ok: false, error: "oauth nonce expired" };
  }

  const exchanged = await exchangeOAuthCode(shop, input.code);
  if (!exchanged.ok) {
    return { ok: false, error: `token exchange failed: ${exchanged.error}` };
  }
  const accessToken = exchanged.data.access_token as string;
  const scope = typeof exchanged.data.scope === "string" ? exchanged.data.scope : ENV.shopifyScopes;

  await updateShopifyState(tenantId, (state) => {
    state.connection = {
      shop,
      accessTokenEncrypted: encryptToken(accessToken),
      scope,
      installedAt: new Date().toISOString(),
    };
    state.pendingOAuth = null; // one-time nonce consumed
  });
  await writeAuditLog({
    tenantId,
    // The token is never included — only non-secret metadata.
    actorId: "shopify-oauth",
    actorName: "Shopify OAuth",
    action: "shopify.connected",
    entityType: "shopifyIntegration",
    entityId: shop,
    details: { shop, scope },
  } as any);
  return { ok: true, tenantId, shop, scope };
}

/**
 * Uninstall: revoke the token at Shopify (best-effort), then clear all
 * connection state. Catalog/order history mappings are kept so a reinstall
 * adopts existing products instead of duplicating.
 */
export async function uninstallShopify(tenantId: string): Promise<{ ok: boolean; revoked: boolean }> {
  const conn = await getShopifyConnection(tenantId);
  let revoked = false;
  if (conn) {
    try {
      revoked = await revokeAccessToken(conn);
    } catch (err: any) {
      console.warn(
        "[shopify] token revocation failed:",
        redactShopifySecrets(err?.message ?? String(err), [conn.accessToken]),
      );
    }
  }
  await updateShopifyState(tenantId, (state) => {
    state.connection = null;
    state.pendingOAuth = null;
  });
  await writeAuditLog({
    tenantId,
    actorId: "shopify-oauth",
    actorName: "Shopify OAuth",
    action: "shopify.disconnected",
    entityType: "shopifyIntegration",
    entityId: conn?.shop ?? "unknown",
    details: { revoked },
  } as any);
  return { ok: true, revoked };
}
