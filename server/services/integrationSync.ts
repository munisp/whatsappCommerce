/**
 * integrationSync.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles fire-and-forget sync to external systems after a WhatsApp order is
 * created.  All calls are best-effort — failures are logged but never throw so
 * the NLP flow is never blocked.
 *
 * Integrations:
 *   1. Medusa v2  — create order via /store/orders (or admin draft)
 *   2. Twenty CRM — upsert contact + create activity note
 *   3. Odoo ERP   — create sale.order via JSON-RPC
 *
 * SINGLE SOURCE OF TRUTH for credentials (split-brain fix):
 *   - Odoo ERP   → odoo_integrations table (baseUrl/database/username/apiKey)
 *   - Twenty CRM → twenty_integrations table (baseUrl/apiKey/workspaceId)
 *   - Medusa     → tenant_integrations row (integrationType "medusa"),
 *                  with process.env MEDUSA_API_URL / MEDUSA_ADMIN_API_KEY /
 *                  MEDUSA_PUBLISHABLE_KEY as a global bootstrap fallback
 *                  (medusaAdapter.ts reads env only; DB values take precedence
 *                  for every per-tenant sync path).
 *
 * tenant_integrations rows for odoo_erp / twenty_crm are lightweight "pointer"
 * records (no secrets) kept for the health dashboard and the cron heartbeats in
 * server/_core/index.ts.  They NEVER carry credentials.
 */

import { getDb } from "../db";
import {
  odooIntegrations,
  twentyIntegrations,
  tenantIntegrations,
} from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";

// ── Structured fetch with retry ───────────────────────────────────────────────

export type FetchJsonResult =
  | { ok: true; status: number; data: any; attempts: number }
  | { ok: false; status: number | null; error: string; attempts: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch JSON with up to `retries` retries (exponential backoff).
 * Retries on network errors and 5xx responses; 4xx responses are final.
 * Never throws — returns a structured result and logs failures so callers
 * (and operators) can see them.
 */
export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  opts: { label: string; retries?: number; timeoutMs?: number; baseDelayMs?: number },
): Promise<FetchJsonResult> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[integrationSync] ${opts.label}: retry ${attempt}/${retries} after ${delay}ms` +
          (lastStatus ? ` (last status ${lastStatus})` : lastError ? ` (last error: ${lastError})` : ""),
      );
      await sleep(delay);
    }
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, status: res.status, data, attempts: attempt + 1 };
      }
      // 4xx (except 429) are deterministic — do not retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = await res.text().catch(() => "");
        const error = `HTTP ${res.status}: ${body.slice(0, 300)}`;
        console.error(`[integrationSync] ${opts.label} failed (final): ${error}`);
        return { ok: false, status: res.status, error, attempts: attempt + 1 };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err: any) {
      lastStatus = null;
      lastError = err?.message ?? String(err);
    }
  }

  const error = lastError ?? "unknown fetch failure";
  console.error(
    `[integrationSync] ${opts.label} failed after ${retries + 1} attempts: ${error}`,
  );
  return { ok: false, status: lastStatus, error, attempts: retries + 1 };
}

// ── Credential resolvers (single source of truth) ─────────────────────────────

export interface OdooIntegrationConfig {
  baseUrl: string;
  database: string;
  username: string;
  apiKey: string;
}

/** Authoritative Odoo credentials — odoo_integrations table. */
export async function getOdooIntegrationConfig(tenantId: string): Promise<OdooIntegrationConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(odooIntegrations)
    .where(eq(odooIntegrations.tenantId, tenantId))
    .limit(1);
  if (!row?.baseUrl || !row?.apiKey || !row?.database || !row?.username) return null;
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ""),
    database: row.database,
    username: row.username,
    apiKey: row.apiKey,
  };
}

export interface TwentyIntegrationConfig {
  baseUrl: string;
  apiKey: string;
  workspaceId: string | null;
}

/** Authoritative Twenty CRM credentials — twenty_integrations table. */
export async function getTwentyIntegrationConfig(tenantId: string): Promise<TwentyIntegrationConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(twentyIntegrations)
    .where(eq(twentyIntegrations.tenantId, tenantId))
    .limit(1);
  if (!row?.baseUrl || !row?.apiKey) return null;
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ""),
    apiKey: row.apiKey,
    workspaceId: row.workspaceId ?? null,
  };
}

export interface MedusaIntegrationConfig {
  baseUrl: string;
  /** Admin API token (x-medusa-access-token). */
  adminApiKey: string | null;
  /** Publishable key for the store API (x-publishable-api-key). */
  publishableKey: string | null;
  source: "db" | "env";
}

/**
 * Medusa credentials — tenant_integrations (integrationType "medusa") is
 * authoritative for per-tenant sync paths.  Falls back to the process-wide
 * MEDUSA_* env bootstrap (medusaAdapter.ts reads env only; see file header).
 */
export async function getMedusaIntegrationConfig(tenantId: string): Promise<MedusaIntegrationConfig | null> {
  const db = await getDb();
  if (db) {
    const [row] = await db
      .select()
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.integrationType, "medusa"),
        ),
      )
      .limit(1);
    if (row?.baseUrl && row?.apiKey) {
      return {
        baseUrl: row.baseUrl.replace(/\/+$/, ""),
        adminApiKey: row.apiKey,
        publishableKey: row.apiSecret ?? null,
        source: "db",
      };
    }
  }
  const envUrl = process.env.MEDUSA_API_URL;
  if (envUrl) {
    return {
      baseUrl: envUrl.replace(/\/+$/, ""),
      adminApiKey: process.env.MEDUSA_ADMIN_API_KEY ?? null,
      publishableKey: process.env.MEDUSA_PUBLISHABLE_KEY ?? null,
      source: "env",
    };
  }
  return null;
}

/**
 * Maintain the lightweight tenant_integrations "pointer" row for an
 * integration whose credentials live in a dedicated table (odoo_integrations /
 * twenty_integrations).  Pointer rows carry NO secrets — they exist so the
 * health dashboard (provisioning.listIntegrations) and the cron heartbeats in
 * server/_core/index.ts can enumerate active integrations.
 */
export async function syncTenantIntegrationPointer(
  tenantId: string,
  integrationType: "odoo_erp" | "twenty_crm",
  baseUrl: string,
  status: "active" | "pending" | "error",
  lastError?: string | null,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const displayName = integrationType === "odoo_erp" ? "Odoo ERP" : "Twenty CRM";
  const [existing] = await db
    .select({ id: tenantIntegrations.id })
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, tenantId),
        eq(tenantIntegrations.integrationType, integrationType),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(tenantIntegrations)
      .set({
        baseUrl,
        status,
        lastHealthCheck: new Date(),
        lastHealthStatus: status === "active" ? "ok" : status === "error" ? "error" : "pending",
        lastError: lastError ?? null,
        updatedAt: new Date(),
      })
      .where(eq(tenantIntegrations.id, existing.id));
  } else {
    await db.insert(tenantIntegrations).values({
      tenantId,
      integrationType,
      displayName,
      baseUrl,
      status,
      lastHealthCheck: new Date(),
      lastHealthStatus: status === "active" ? "ok" : status === "error" ? "error" : "pending",
      lastError: lastError ?? null,
    });
  }
}

// ── Odoo JSON-RPC primitives ──────────────────────────────────────────────────

async function odooJsonRpcRaw(
  base: string,
  params: Record<string, unknown>,
  label: string,
): Promise<any> {
  const res = await fetchJsonWithRetry(
    `${base}/jsonrpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
    },
    { label },
  );
  if (!res.ok) {
    throw new Error(`Odoo JSON-RPC ${label} request failed: ${res.error}`);
  }
  if (res.data?.error) {
    const msg =
      res.data.error?.data?.message ??
      res.data.error?.message ??
      JSON.stringify(res.data.error).slice(0, 300);
    throw new Error(`Odoo JSON-RPC ${label} error: ${msg}`);
  }
  return res.data?.result;
}

/**
 * Authenticate against Odoo (common/authenticate) and return the uid.
 * Throws an honest error when the server is unreachable or credentials are
 * rejected — callers must NOT treat an exception as success.
 */
export async function odooAuthenticate(cfg: OdooIntegrationConfig): Promise<number> {
  const uid = await odooJsonRpcRaw(
    cfg.baseUrl,
    {
      service: "common",
      method: "authenticate",
      args: [cfg.database, cfg.username, cfg.apiKey, {}],
    },
    "common/authenticate",
  );
  if (typeof uid !== "number" || uid <= 0) {
    throw new Error("Odoo authentication rejected the database/username/api-key combination");
  }
  return uid;
}

/** execute_kw against an authenticated Odoo session. Throws on failure. */
export async function odooExecuteKw(
  cfg: OdooIntegrationConfig,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<any> {
  return odooJsonRpcRaw(
    cfg.baseUrl,
    {
      service: "object",
      method: "execute_kw",
      args: [cfg.database, uid, cfg.apiKey, model, method, args, kwargs],
    },
    `execute_kw ${model}.${method}`,
  );
}

// ── WhatsApp Cloud API text sender ────────────────────────────────────────────

export type WhatsAppSendResult =
  | { sent: true; wamid: string | null }
  | { sent: false; notConfigured: boolean; error: string };

/**
 * Send a real WhatsApp text message via the Meta WhatsApp Business Cloud API.
 * This is the same transport used by whatsappNotifications.sendAdminReply.
 * When WAC_WHATSAPP_TOKEN / WAC_WHATSAPP_PHONE_ID are missing the function
 * returns an honest NOT_CONFIGURED failure — it NEVER simulates a send.
 */
export async function sendWhatsAppTextMessage(to: string, body: string): Promise<WhatsAppSendResult> {
  const token = process.env.WAC_WHATSAPP_TOKEN;
  const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    return {
      sent: false,
      notConfigured: true,
      error:
        "NOT_CONFIGURED: WhatsApp Cloud API credentials are not set " +
        "(WAC_WHATSAPP_TOKEN / WAC_WHATSAPP_PHONE_ID)",
    };
  }
  const res = await fetchJsonWithRetry(
    `https://graph.facebook.com/v21.0/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to.replace(/[^0-9]/g, ""),
        type: "text",
        text: { body, preview_url: false },
      }),
    },
    { label: "whatsapp-cloud-api send", retries: 1, timeoutMs: 12000 },
  );
  if (!res.ok) {
    return { sent: false, notConfigured: false, error: res.error };
  }
  const wamid: string | null = res.data?.messages?.[0]?.id ?? null;
  return { sent: true, wamid };
}

// ── Medusa v2 ─────────────────────────────────────────────────────────────────

export async function syncOrderToMedusa(
  tenantId: string,
  order: {
    id: string;
    orderNumber: string;
    total: number;
    currency: string;
    phone: string;
    address: string | null;
    items: Array<{ productId: string; name: string; qty: number; price: string | number }>;
  },
): Promise<string | null> {
  const cfg = await getMedusaIntegrationConfig(tenantId);
  if (!cfg?.adminApiKey) return null; // not configured for this tenant

  // 1. Create a draft order via Medusa admin API
  const payload = {
    email: `${order.phone.replace(/\D/g, "")}@whatsapp.local`,
    items: order.items.map((i) => ({
      variant_id: i.productId,
      quantity: i.qty,
      unit_price: Math.round(Number(i.price) * 100), // Medusa uses cents
    })),
    currency_code: order.currency.toLowerCase(),
    metadata: {
      platform_order_id: order.id,
      platform_order_number: order.orderNumber,
      whatsapp_phone: order.phone,
      shipping_address_raw: order.address ?? "",
    },
  };

  const result = await fetchJsonWithRetry(
    `${cfg.baseUrl}/admin/orders`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-medusa-access-token": cfg.adminApiKey,
      },
      body: JSON.stringify(payload),
    },
    { label: `medusa syncOrder tenant=${tenantId} order=${order.orderNumber}` },
  );

  if (!result.ok) return null; // failure already logged with full detail
  return result.data?.order?.id ?? null;
}

// ── Twenty CRM ────────────────────────────────────────────────────────────────

export async function syncContactToTwenty(
  tenantId: string,
  phone: string,
  name?: string,
): Promise<string | null> {
  const cfg = await getTwentyIntegrationConfig(tenantId);
  if (!cfg) return null; // not configured for this tenant

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  // Twenty CRM uses GraphQL
  const upsertMutation = `
    mutation UpsertPerson($phone: String!, $name: String) {
      upsertPerson(
        input: {
          phones: { primaryPhoneNumber: $phone, primaryPhoneCountryCode: "+234" }
          name: { firstName: $name, lastName: "" }
        }
        conflictPaths: ["phones.primaryPhoneNumber"]
      ) { id name { firstName } }
    }
  `;

  const result = await fetchJsonWithRetry(
    `${cfg.baseUrl}/api`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: upsertMutation,
        variables: { phone, name: name ?? phone },
      }),
    },
    { label: `twenty syncContact tenant=${tenantId}` },
  );

  if (!result.ok) return null; // failure already logged
  if (result.data?.errors) {
    console.error(
      `[integrationSync] twenty syncContact tenant=${tenantId} GraphQL errors:`,
      JSON.stringify(result.data.errors).slice(0, 500),
    );
    return null;
  }
  return result.data?.data?.upsertPerson?.id ?? null;
}

export async function pushOrderActivityToTwenty(
  tenantId: string,
  personId: string,
  orderNumber: string,
  total: number,
  currency: string,
): Promise<void> {
  const cfg = await getTwentyIntegrationConfig(tenantId);
  if (!cfg || !personId) return;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  const createNote = `
    mutation CreateNote($body: String!, $personId: ID!) {
      createNote(
        input: {
          body: $body
          noteTargets: { create: [{ personId: $personId }] }
        }
      ) { id }
    }
  `;

  const result = await fetchJsonWithRetry(
    `${cfg.baseUrl}/api`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: createNote,
        variables: {
          body: `WhatsApp order ${orderNumber} placed — ${currency} ${total.toFixed(2)}`,
          personId,
        },
      }),
    },
    { label: `twenty pushOrderActivity tenant=${tenantId} order=${orderNumber}` },
  );

  if (result.ok && result.data?.errors) {
    console.error(
      `[integrationSync] twenty pushOrderActivity tenant=${tenantId} GraphQL errors:`,
      JSON.stringify(result.data.errors).slice(0, 500),
    );
  }
}

// ── Odoo ERP ──────────────────────────────────────────────────────────────────

export async function syncOrderToOdoo(
  tenantId: string,
  order: {
    id: string;
    orderNumber: string;
    total: number;
    currency: string;
    phone: string;
    items: Array<{ productId: string; name: string; qty: number; price: string | number }>;
  },
): Promise<number | null> {
  const cfg = await getOdooIntegrationConfig(tenantId);
  if (!cfg) return null; // not configured for this tenant

  let uid: number;
  try {
    uid = await odooAuthenticate(cfg);
  } catch (err: any) {
    console.error(
      `[integrationSync] odoo syncOrder tenant=${tenantId} order=${order.orderNumber}: authenticate failed: ${err?.message ?? err}`,
    );
    return null;
  }

  // Build order lines: [0, 0, { product_id, product_uom_qty, price_unit, name }]
  const orderLines = order.items.map((i) => [
    0,
    0,
    {
      product_id: parseInt(i.productId) || false,
      name: i.name,
      product_uom_qty: i.qty,
      price_unit: Number(i.price),
    },
  ]);

  try {
    const result = await odooExecuteKw(
      cfg,
      uid,
      "sale.order",
      "create",
      [
        {
          name: order.orderNumber,
          partner_id: 1, // default partner; ideally resolved by phone
          order_line: orderLines,
          note: `WhatsApp order from ${order.phone}. Platform ID: ${order.id}`,
        },
      ],
      {},
    );
    return typeof result === "number" ? result : null;
  } catch (err: any) {
    console.error(
      `[integrationSync] odoo syncOrder tenant=${tenantId} order=${order.orderNumber}: create failed: ${err?.message ?? err}`,
    );
    return null;
  }
}

// ── Inventory sync from Odoo ──────────────────────────────────────────────────

export async function fetchOdooStockLevels(
  tenantId: string,
): Promise<Array<{ productId: string; qty: number }>> {
  const cfg = await getOdooIntegrationConfig(tenantId);
  if (!cfg) return []; // not configured for this tenant

  try {
    const uid = await odooAuthenticate(cfg);
    const result = await odooExecuteKw(
      cfg,
      uid,
      "stock.quant",
      "search_read",
      [[["location_id.usage", "=", "internal"]]],
      { fields: ["product_id", "quantity"], limit: 500 },
    );
    if (!Array.isArray(result)) return [];
    return result.map((r: any) => ({
      productId: String(r.product_id?.[0] ?? ""),
      qty: Number(r.quantity ?? 0),
    }));
  } catch (err: any) {
    console.error(
      `[integrationSync] odoo fetchOdooStockLevels tenant=${tenantId} failed: ${err?.message ?? err}`,
    );
    return [];
  }
}

// ── Medusa catalog sync ───────────────────────────────────────────────────────

export async function fetchMedusaCatalog(
  tenantId: string,
): Promise<Array<{ id: string; title: string; price: number; currency: string; stock: number }>> {
  const cfg = await getMedusaIntegrationConfig(tenantId);
  const storeKey = cfg?.publishableKey ?? cfg?.adminApiKey;
  if (!cfg || !storeKey) return []; // not configured for this tenant

  const result = await fetchJsonWithRetry(
    `${cfg.baseUrl}/store/products?limit=100&expand=variants,variants.prices`,
    {
      headers: {
        "x-publishable-api-key": storeKey,
      },
    },
    { label: `medusa fetchCatalog tenant=${tenantId}` },
  );

  if (!result.ok || !result.data?.products) return [];
  return (result.data.products as any[]).flatMap((p: any) =>
    (p.variants ?? []).map((v: any) => ({
      id: v.id,
      title: `${p.title} — ${v.title}`,
      price: (v.prices?.[0]?.amount ?? 0) / 100,
      currency: (v.prices?.[0]?.currency_code ?? "NGN").toUpperCase(),
      stock: v.inventory_quantity ?? 0,
    })),
  );
}
