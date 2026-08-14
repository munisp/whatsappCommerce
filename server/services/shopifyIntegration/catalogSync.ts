/**
 * shopifyIntegration/catalogSync.ts — push platform products → Shopify
 * (roadmap F7, capability catalog_sync_out).
 *
 * Idempotency contract:
 *   - The sku → Shopify product id mapping is persisted in tenant settings
 *     (state.catalog.externalIds) after every successful write.
 *   - Re-runs UPDATE mapped products (never duplicate).
 *   - Unmapped products are searched by handle (slugified SKU) before
 *     create, so products created outside this flow are ADOPTED.
 *   - dryRun: no network calls, no state mutation — returns planned actions.
 *   - Per-item failure isolation: one failing product never aborts the batch.
 */
import { eq } from "drizzle-orm";
import { products } from "../../../drizzle/schema";
import { writeAuditLog } from "../../routers/audit";
import { shopifyApi } from "./client";
import {
  getShopifyConnection,
  loadTenantSettings,
  readShopifyState,
  updateShopifyState,
  type ShopifySyncItemResult,
} from "./state";

export interface CatalogSyncSummary {
  ok: boolean;
  dryRun: boolean;
  created: number;
  updated: number;
  failed: number;
  items: ShopifySyncItemResult[];
}

function handleForSku(sku: string): string {
  return sku.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  imageUrl: string | null;
  status: string;
  stockQuantity: number;
}

function toShopifyProduct(p: ProductRow) {
  return {
    product: {
      title: p.name,
      body_html: p.description ?? "",
      handle: handleForSku(p.sku),
      status: p.status === "active" ? "active" : "draft",
      images: p.imageUrl ? [{ src: p.imageUrl }] : [],
      variants: [
        {
          sku: p.sku,
          price: p.price,
          inventory_quantity: p.stockQuantity,
          inventory_management: "shopify",
        },
      ],
    },
  };
}

/**
 * Push all tenant products to Shopify. Idempotent; per-item failure
 * isolation; summary persisted to tenant settings + audit-logged.
 */
export async function syncCatalogToShopify(
  tenantId: string,
  opts: { dryRun?: boolean } = {},
): Promise<CatalogSyncSummary> {
  const dryRun = opts.dryRun === true;
  const { db, settings } = await loadTenantSettings(tenantId);
  const state = readShopifyState(settings);
  const conn = await getShopifyConnection(tenantId);
  if (!conn && !dryRun) {
    throw new Error("shopify not connected");
  }

  const rows = (await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      description: products.description,
      price: products.price,
      currency: products.currency,
      imageUrl: products.imageUrl,
      status: products.status,
      stockQuantity: products.stockQuantity,
    })
    .from(products)
    .where(eq(products.tenantId, tenantId))) as ProductRow[];

  const items: ShopifySyncItemResult[] = [];

  for (const p of rows) {
    try {
      const mappedId = state.catalog.externalIds[p.sku];
      if (dryRun) {
        items.push({
          sku: p.sku,
          action: mappedId ? "updated" : "created",
          externalId: mappedId,
        });
        continue;
      }
      if (mappedId) {
        // Known mapping → update in place.
        const res = await shopifyApi(conn!, "PUT", `/products/${mappedId}.json`, toShopifyProduct(p));
        if (res.ok) {
          items.push({ sku: p.sku, action: "updated", externalId: mappedId });
        } else if (res.status === 404) {
          // Mapping stale (product deleted in Shopify) → recreate below.
          const created = await createOrAdopt(conn!, p);
          items.push(created);
          if (created.externalId) state.catalog.externalIds[p.sku] = created.externalId;
          else delete state.catalog.externalIds[p.sku];
        } else {
          items.push({ sku: p.sku, action: "failed", externalId: mappedId, error: res.error });
        }
        continue;
      }
      const created = await createOrAdopt(conn!, p);
      items.push(created);
      if (created.externalId) state.catalog.externalIds[p.sku] = created.externalId;
    } catch (err: any) {
      // Per-item failure isolation — never abort the batch.
      items.push({ sku: p.sku, action: "failed", error: err?.message ?? String(err) });
    }
  }

  const summary: CatalogSyncSummary = {
    ok: items.every((i) => i.action !== "failed"),
    dryRun,
    created: items.filter((i) => i.action === "created" || i.action === "adopted").length,
    updated: items.filter((i) => i.action === "updated").length,
    failed: items.filter((i) => i.action === "failed").length,
    items,
  };

  if (!dryRun) {
    const finalItems = items;
    await updateShopifyState(tenantId, (s) => {
      s.catalog.externalIds = { ...state.catalog.externalIds };
      s.catalog.lastSyncAt = new Date().toISOString();
      s.catalog.lastResults = {
        created: summary.created,
        updated: summary.updated,
        failed: summary.failed,
        items: finalItems,
      };
    });
    await writeAuditLog({
      tenantId,
      actorId: "shopify-sync",
      actorName: "Shopify Catalog Sync",
      action: "shopify.catalog.synced",
      entityType: "shopifyIntegration",
      entityId: conn!.shop,
      details: { created: summary.created, updated: summary.updated, failed: summary.failed },
    } as any);
  }
  return summary;
}

/** Search-before-create: adopt by handle, otherwise create. */
async function createOrAdopt(
  conn: { shop: string; accessToken: string },
  p: ProductRow,
): Promise<ShopifySyncItemResult> {
  const handle = handleForSku(p.sku);
  const found = await shopifyApi(conn, "GET", `/products.json?handle=${encodeURIComponent(handle)}&fields=id,handle`);
  if (found.ok) {
    const existing = (found.data as any)?.products?.[0];
    if (existing?.id) {
      const externalId = String(existing.id);
      const upd = await shopifyApi(conn, "PUT", `/products/${externalId}.json`, toShopifyProduct(p));
      if (upd.ok) return { sku: p.sku, action: "adopted", externalId };
      // Adopted id was itself stale (deleted in Shopify between search and
      // update) → fall through to create.
      if (upd.status !== 404) return { sku: p.sku, action: "failed", externalId, error: upd.error };
    }
  }
  const res = await shopifyApi(conn, "POST", "/products.json", toShopifyProduct(p));
  if (res.ok && (res.data as any)?.product?.id) {
    return { sku: p.sku, action: "created", externalId: String((res.data as any).product.id) };
  }
  return { sku: p.sku, action: "failed", error: res.ok ? "missing product id in response" : (res as any).error };
}
