/**
 * shopifyIntegration/client.ts — minimal Shopify Admin REST client with an
 * injectable fetch (customHttp-style), a hard per-request timeout, and
 * redacted error text. Never throws: returns a structured result so callers
 * can do per-item failure isolation.
 */
import { ENV } from "../../_core/env";
import { redactShopifySecrets } from "./security";

export interface ShopifyHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ShopifyFetch = (url: string, init: RequestInit) => Promise<ShopifyHttpResponse>;

let fetchImpl: ShopifyFetch = (globalThis.fetch as unknown as ShopifyFetch);

/** Test hook: inject a stub fetch (customHttp-style). Restored via resetShopifyFetch(). */
export function setShopifyFetch(fn: ShopifyFetch): void {
  fetchImpl = fn;
}
export function resetShopifyFetch(): void {
  fetchImpl = globalThis.fetch as unknown as ShopifyFetch;
}

export type ShopifyApiResult =
  | { ok: true; status: number; data: any }
  | { ok: false; status: number | null; error: string };

/** Per-shop credentials resolved from tenant state (never logged). */
export interface ShopifyConnection {
  shop: string; // e.g. "my-store.myshopify.com"
  accessToken: string;
}

function apiBase(conn: ShopifyConnection): string {
  return `https://${conn.shop}/admin/api/${ENV.shopifyApiVersion}`;
}

/**
 * Call the Shopify Admin REST API. Timeout defaults to SHOPIFY_TIMEOUT_MS
 * (8s). Error strings are redacted of the access token/app secret before
 * return.
 */
export async function shopifyApi(
  conn: ShopifyConnection,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ShopifyApiResult> {
  const url = `${apiBase(conn)}${path}`;
  const timeoutMs = ENV.shopifyTimeoutMs > 0 ? ENV.shopifyTimeoutMs : 8000;
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        "X-Shopify-Access-Token": conn.accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    const status = res.status;
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: true, status, data };
    }
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status,
      error: redactShopifySecrets(`HTTP ${status}: ${text.slice(0, 300)}`, [
        conn.accessToken,
        ENV.shopifyApiSecret,
      ]),
    };
  } catch (err: any) {
    return {
      ok: false,
      status: null,
      error: redactShopifySecrets(err?.message ?? String(err), [
        conn.accessToken,
        ENV.shopifyApiSecret,
      ]),
    };
  }
}

/**
 * Exchange an OAuth authorization code for a permanent access token.
 * Uses the raw (unauthenticated) OAuth endpoint, 8s timeout, redacted errors.
 */
export async function exchangeOAuthCode(
  shop: string,
  code: string,
): Promise<ShopifyApiResult> {
  const url = `https://${shop}/admin/oauth/access_token`;
  const timeoutMs = ENV.shopifyTimeoutMs > 0 ? ENV.shopifyTimeoutMs : 8000;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: ENV.shopifyApiKey,
        client_secret: ENV.shopifyApiSecret,
        code,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    const status = res.status;
    const data = (await res.json().catch(() => ({}))) as any;
    if (res.ok && typeof data?.access_token === "string") {
      return { ok: true, status, data };
    }
    return {
      ok: false,
      status,
      error: redactShopifySecrets(
        `HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`,
        [ENV.shopifyApiSecret],
      ),
    };
  } catch (err: any) {
    return {
      ok: false,
      status: null,
      error: redactShopifySecrets(err?.message ?? String(err), [ENV.shopifyApiSecret]),
    };
  }
}

/** Best-effort token revocation on uninstall (DELETE api_permissions/current). */
export async function revokeAccessToken(conn: ShopifyConnection): Promise<boolean> {
  const result = await shopifyApi(conn, "DELETE", "/api_permissions/current.json");
  return result.ok;
}
