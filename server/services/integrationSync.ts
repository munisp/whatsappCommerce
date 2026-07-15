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
 */

import { getDb } from "../db";
import { tenantIntegrations } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";

// ── helpers ──────────────────────────────────────────────────────────────────

async function getTenantIntegration(tenantId: string, type: string) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, tenantId),
        eq(tenantIntegrations.integrationType, type as any),
        eq(tenantIntegrations.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function safeFetch(url: string, init: RequestInit): Promise<any> {
  try {
    const res = await fetch(url, init);
    return res.ok ? await res.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
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
  const integration = await getTenantIntegration(tenantId, "medusa");
  if (!integration?.baseUrl || !integration?.apiKey) return null;

  const base = integration.baseUrl.replace(/\/$/, "");

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

  const result = await safeFetch(`${base}/admin/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-medusa-access-token": integration.apiKey,
    },
    body: JSON.stringify(payload),
  });

  return result?.order?.id ?? null;
}

// ── Twenty CRM ────────────────────────────────────────────────────────────────

export async function syncContactToTwenty(
  tenantId: string,
  phone: string,
  name?: string,
): Promise<string | null> {
  const integration = await getTenantIntegration(tenantId, "twenty_crm");
  if (!integration?.baseUrl || !integration?.apiKey) return null;

  const base = integration.baseUrl.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${integration.apiKey}`,
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

  const result = await safeFetch(`${base}/api`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: upsertMutation,
      variables: { phone, name: name ?? phone },
    }),
  });

  return result?.data?.upsertPerson?.id ?? null;
}

export async function pushOrderActivityToTwenty(
  tenantId: string,
  personId: string,
  orderNumber: string,
  total: number,
  currency: string,
): Promise<void> {
  const integration = await getTenantIntegration(tenantId, "twenty_crm");
  if (!integration?.baseUrl || !integration?.apiKey || !personId) return;

  const base = integration.baseUrl.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${integration.apiKey}`,
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

  await safeFetch(`${base}/api`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: createNote,
      variables: {
        body: `WhatsApp order ${orderNumber} placed — ${currency} ${total.toFixed(2)}`,
        personId,
      },
    }),
  });
}

// ── Odoo ERP ──────────────────────────────────────────────────────────────────

async function odooJsonRpc(
  base: string,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return safeFetch(`${base}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      id: Date.now(),
      params: { service: "object", method, ...params },
    }),
  });
}

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
  const integration = await getTenantIntegration(tenantId, "odoo_erp");
  if (!integration?.baseUrl || !integration?.apiKey) return null;

  const base = integration.baseUrl.replace(/\/$/, "");
  const config = (integration.config ?? {}) as Record<string, unknown>;
  const db_name = (config.db_name as string) ?? "odoo";
  const uid = (config.uid as number) ?? 1;
  const password = integration.apiSecret ?? integration.apiKey;

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

  const result = await odooJsonRpc(base, "execute_kw", {
    db: db_name,
    uid,
    password,
    model: "sale.order",
    method: "create",
    args: [
      {
        name: order.orderNumber,
        partner_id: 1, // default partner; ideally resolved by phone
        order_line: orderLines,
        note: `WhatsApp order from ${order.phone}. Platform ID: ${order.id}`,
      },
    ],
    kwargs: {},
  });

  return result?.result ?? null;
}

// ── Inventory sync from Odoo ──────────────────────────────────────────────────

export async function fetchOdooStockLevels(
  tenantId: string,
): Promise<Array<{ productId: string; qty: number }>> {
  const integration = await getTenantIntegration(tenantId, "odoo_erp");
  if (!integration?.baseUrl || !integration?.apiKey) return [];

  const base = integration.baseUrl.replace(/\/$/, "");
  const config = (integration.config ?? {}) as Record<string, unknown>;
  const db_name = (config.db_name as string) ?? "odoo";
  const uid = (config.uid as number) ?? 1;
  const password = integration.apiSecret ?? integration.apiKey;

  const result = await odooJsonRpc(base, "execute_kw", {
    db: db_name,
    uid,
    password,
    model: "stock.quant",
    method: "search_read",
    args: [[["location_id.usage", "=", "internal"]]],
    kwargs: { fields: ["product_id", "quantity"], limit: 500 },
  });

  if (!result?.result) return [];
  return (result.result as any[]).map((r: any) => ({
    productId: String(r.product_id?.[0] ?? ""),
    qty: Number(r.quantity ?? 0),
  }));
}

// ── Medusa catalog sync ───────────────────────────────────────────────────────

export async function fetchMedusaCatalog(
  tenantId: string,
): Promise<Array<{ id: string; title: string; price: number; currency: string; stock: number }>> {
  const integration = await getTenantIntegration(tenantId, "medusa");
  if (!integration?.baseUrl || !integration?.apiKey) return [];

  const base = integration.baseUrl.replace(/\/$/, "");
  const result = await safeFetch(
    `${base}/store/products?limit=100&expand=variants,variants.prices`,
    {
      headers: {
        "x-publishable-api-key": integration.apiKey,
      },
    },
  );

  if (!result?.products) return [];
  return (result.products as any[]).flatMap((p: any) =>
    (p.variants ?? []).map((v: any) => ({
      id: v.id,
      title: `${p.title} — ${v.title}`,
      price: (v.prices?.[0]?.amount ?? 0) / 100,
      currency: (v.prices?.[0]?.currency_code ?? "NGN").toUpperCase(),
      stock: v.inventory_quantity ?? 0,
    })),
  );
}
