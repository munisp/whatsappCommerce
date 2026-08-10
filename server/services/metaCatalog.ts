/**
 * server/services/metaCatalog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-tenant Meta (Facebook/Instagram) Product Catalog sync.
 *
 * Config lives in tenants.settings.metaCatalog:
 *   { catalogId: string, accessToken: string, enabled: boolean,
 *     status?: { lastRunAt, lastAction, synced, failed, lastError } }
 *
 * Mapping (products → Meta catalog items):
 *   retailer_id  = product.id
 *   name         = product.name
 *   description  = product.description
 *   price        = "<major units with 2dp> <CURRENCY>"  (stored decimal
 *                  string "1234.50" is already major units — parsed with
 *                  Number and re-rendered to avoid float drift)
 *   image_url    = product.imageUrl
 *   availability = "in stock" | "out of stock" (from stockQuantity)
 *
 * Sync is fire-and-forget from product mutations; failures are recorded in
 * settings.metaCatalog.status.lastError and retried on the next sync
 * (upserts are idempotent by retailer_id).
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { products, tenants } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface MetaCatalogConfig {
  catalogId: string;
  accessToken: string;
  enabled: boolean;
}

export interface MetaCatalogStatus {
  lastRunAt: string | null;
  lastAction: string | null;
  synced: number;
  failed: number;
  lastError: string | null;
}

export interface MetaCatalogItem {
  retailer_id: string;
  name: string;
  description?: string;
  price: string; // "<major> <CURRENCY>"
  image_url?: string;
  availability: "in stock" | "out of stock";
}

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/** Read settings.metaCatalog; returns null when not configured/enabled. */
export async function getMetaCatalogConfig(db: Db, tenantId: string): Promise<MetaCatalogConfig | null> {
  const [tenant] = await db.select({ settings: tenants.settings }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);
  const cfg = ((tenant?.settings as any)?.metaCatalog ?? {}) as Partial<MetaCatalogConfig>;
  if (cfg.enabled !== true || !cfg.catalogId || !cfg.accessToken) return null;
  // Stored encrypted (v1:) since w10 — decryptSecret passes legacy plaintext through.
  return { catalogId: cfg.catalogId, accessToken: decryptSecret(cfg.accessToken), enabled: true };
}

/** Map a products row to a Meta catalog item (pure — unit-tested). */
export function mapProductToMetaItem(product: {
  id: string;
  name: string;
  description?: string | null;
  price: string | number;
  currency?: string | null;
  imageUrl?: string | null;
  stockQuantity?: number | null;
}): MetaCatalogItem {
  // products.price is a decimal string in MAJOR units ("1234.50"). If a
  // caller ever hands us integer minor units (≥100x heuristics are unsafe),
  // normalize via Number and render with 2 decimals — no float math beyond
  // one toFixed.
  const major = typeof product.price === "number" ? product.price : Number(product.price);
  const currency = (product.currency ?? "NGN").toUpperCase();
  const item: MetaCatalogItem = {
    retailer_id: product.id,
    name: product.name,
    price: `${(Number.isFinite(major) ? major : 0).toFixed(2)} ${currency}`,
    availability: (product.stockQuantity ?? 0) > 0 ? "in stock" : "out of stock",
  };
  if (product.description) item.description = product.description;
  if (product.imageUrl) item.image_url = product.imageUrl;
  return item;
}

/** Persist the sync status block under settings.metaCatalog.status. */
async function recordStatus(db: Db, tenantId: string, patch: Partial<MetaCatalogStatus>): Promise<void> {
  try {
    const [tenant] = await db.select({ settings: tenants.settings }).from(tenants)
      .where(eq(tenants.id, tenantId)).limit(1);
    const settings = JSON.parse(JSON.stringify(tenant?.settings ?? {}));
    const meta = settings.metaCatalog ?? {};
    const prev: MetaCatalogStatus = meta.status ?? { lastRunAt: null, lastAction: null, synced: 0, failed: 0, lastError: null };
    meta.status = { ...prev, ...patch };
    settings.metaCatalog = meta;
    await db.update(tenants).set({ settings, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  } catch (e: any) {
    console.error("[metaCatalog] status persist failed:", e?.message);
  }
}

/** POST one batch of item requests to /{catalogId}/items. Throws on failure. */
async function postItemsBatch(
  cfg: MetaCatalogConfig,
  requests: Array<Record<string, unknown>>,
): Promise<void> {
  const resp = await fetch(`${GRAPH_BASE}/${cfg.catalogId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item_type: "PRODUCT_ITEM",
      access_token: cfg.accessToken,
      requests,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Meta catalog batch failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
}

export interface SyncResult {
  skipped?: boolean;
  synced: number;
  failed: number;
  lastError?: string | null;
}

/**
 * Upsert products into the tenant's Meta catalog. With no productIds, syncs
 * every non-archived product for the tenant (batch chunks of 100).
 */
export async function syncCatalog(tenantId: string, productIds?: string[]): Promise<SyncResult> {
  const db = await getDb();
  if (!db) return { skipped: true, synced: 0, failed: 0, lastError: "db-unavailable" };
  const cfg = await getMetaCatalogConfig(db, tenantId);
  if (!cfg) return { skipped: true, synced: 0, failed: 0 };

  const rows = productIds?.length
    ? await db.select().from(products).where(inArray(products.id, productIds))
    : await db.select().from(products).where(eq(products.tenantId, tenantId));
  const eligible = rows.filter((p: any) => p.tenantId === tenantId && p.status !== "archived");

  let synced = 0;
  let failed = 0;
  let lastError: string | null = null;
  const CHUNK = 100;
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const chunk = eligible.slice(i, i + CHUNK);
    const requests = chunk.map((p: any) => ({ method: "UPDATE", retailer_id: p.id, data: mapProductToMetaItem(p) }));
    try {
      await postItemsBatch(cfg, requests);
      synced += chunk.length;
    } catch (e: any) {
      failed += chunk.length;
      lastError = e?.message ?? String(e);
      console.error("[metaCatalog] batch sync failed:", lastError);
    }
  }
  await recordStatus(db, tenantId, {
    lastRunAt: new Date().toISOString(),
    lastAction: productIds?.length ? "upsert" : "full_sync",
    synced,
    failed,
    lastError,
  });
  return { synced, failed, lastError };
}

/** Remove one product from the Meta catalog (product delete / archive). */
export async function deleteCatalogItem(tenantId: string, productId: string): Promise<SyncResult> {
  const db = await getDb();
  if (!db) return { skipped: true, synced: 0, failed: 0, lastError: "db-unavailable" };
  const cfg = await getMetaCatalogConfig(db, tenantId);
  if (!cfg) return { skipped: true, synced: 0, failed: 0 };
  try {
    await postItemsBatch(cfg, [{ method: "DELETE", retailer_id: productId }]);
    await recordStatus(db, tenantId, {
      lastRunAt: new Date().toISOString(),
      lastAction: "delete",
      synced: 1,
      failed: 0,
      lastError: null,
    });
    return { synced: 1, failed: 0, lastError: null };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await recordStatus(db, tenantId, {
      lastRunAt: new Date().toISOString(),
      lastAction: "delete",
      synced: 0,
      failed: 1,
      lastError: msg,
    });
    return { synced: 0, failed: 1, lastError: msg };
  }
}

/**
 * Fire-and-forget hook for product mutations. Action "deleted" (or an
 * "archived" status update) removes the item; anything else upserts it so
 * availability/price changes propagate. Never throws.
 */
export function notifyMetaCatalogProductChanged(
  tenantId: string,
  productId: string,
  action: "created" | "updated" | "deleted",
): void {
  const work = action === "deleted"
    ? deleteCatalogItem(tenantId, productId)
    : syncCatalog(tenantId, [productId]);
  work.catch((e: any) => console.error("[metaCatalog] hook failed:", e?.message));
}
