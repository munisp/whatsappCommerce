/**
 * server/services/medusa/sync.ts — W28 catalog sync Medusa → platform.
 *
 * Two entry points:
 *  - handleMedusaProductEvent: webhook-driven product.created/updated/deleted
 *    → idempotent upsert into the platform `products` table keyed by
 *    metadata->>'medusaId' with metadata.source = "medusa". Platform-native
 *    products (no metadata.source="medusa") are NEVER modified by sync.
 *  - backfillMedusaCatalog: tenant-triggered full pull through the adapter.
 *
 * Idempotency: upserts match on (tenantId, metadata->>'medusaId'); replays of
 * the same webhook event converge to the same row. Deletes soft-archive
 * (status="inactive") only medusa-sourced rows. Prices: Medusa amounts are
 * integer minor units; the platform stores decimal major units — conversion
 * is exact integer math (cents → "major.minor" string).
 */
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { medusaStoreMappings, products } from "../../../drizzle/schema";
import type { MedusaAdapter, MedusaProduct } from "./adapter";

type Db = NonNullable<Awaited<ReturnType<typeof import("../../db").getDb>>>;

/** cents (integer) → decimal string with exactly 2dp ("8500.00"). */
export function centsToDecimalString(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${major}.${minor}`;
}

/** Pick the displayable variant price (first price) → {price, currency}. */
function variantPrice(p: MedusaProduct, fallbackCurrency: string): { price: string; currency: string } {
  const v = p.variants?.[0];
  const pr = v?.prices?.[0];
  if (!pr) return { price: "0.00", currency: fallbackCurrency.toUpperCase() };
  return { price: centsToDecimalString(pr.amount), currency: pr.currency_code.toUpperCase() };
}

function totalInventory(p: MedusaProduct): number {
  return (p.variants ?? []).reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0);
}

/** Find the platform product row synced from this Medusa product, if any. */
async function findSyncedProduct(db: Db, tenantId: string, medusaId: string) {
  const rows = await db
    .select({
      id: products.id,
      metadata: products.metadata,
      status: products.status,
    })
    .from(products)
    .where(and(
      eq(products.tenantId, tenantId),
      sql`${products.metadata}->>'medusaId' = ${medusaId}`,
      sql`${products.metadata}->>'source' = 'medusa'`,
    ))
    .limit(1)
    .catch(() => []);
  return rows[0] ?? null;
}

export interface MedusaProductEventResult {
  action: "created" | "updated" | "archived" | "skipped" | "ignored";
  productId?: string;
  reason?: string;
}

/**
 * Apply one Medusa product webhook event. Idempotent: replaying the same
 * event produces the same resulting row; platform-native products are never
 * touched (all writes are guarded to metadata.source = "medusa" rows or new
 * inserts with a `med:` SKU prefix that cannot collide with merchant SKUs).
 */
export async function handleMedusaProductEvent(
  db: Db,
  tenantId: string,
  event: string,
  data: MedusaProduct,
): Promise<MedusaProductEventResult> {
  const medusaId = data?.id;
  if (!medusaId) return { action: "ignored", reason: "missing product id" };

  if (event === "product.deleted") {
    const existing = await findSyncedProduct(db, tenantId, medusaId);
    if (!existing) return { action: "skipped", reason: "not synced" };
    if (existing.status === "inactive") return { action: "skipped", reason: "already archived" };
    await db
      .update(products)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(and(eq(products.id, existing.id), sql`${products.metadata}->>'source' = 'medusa'`));
    await stampWebhookAt(db, tenantId);
    return { action: "archived", productId: existing.id };
  }

  if (event !== "product.created" && event !== "product.updated") {
    return { action: "ignored", reason: `unsupported event ${event}` };
  }

  const { price, currency } = variantPrice(data, "NGN");
  const stock = totalInventory(data);
  const existing = await findSyncedProduct(db, tenantId, medusaId);
  const metadata = {
    source: "medusa",
    medusaId,
    medusaVariantId: data.variants?.[0]?.id ?? null,
    medusaHandle: data.handle ?? null,
    medusaStatus: data.status ?? null,
  };

  if (existing) {
    // Guarded update: only ever rewrites medusa-sourced rows.
    await db
      .update(products)
      .set({
        name: data.title,
        description: data.description ?? null,
        price,
        currency,
        imageUrl: data.thumbnail ?? null,
        stockQuantity: stock,
        status: data.status === "published" || !data.status ? "active" : "inactive",
        metadata,
        updatedAt: new Date(),
      })
      .where(and(eq(products.id, existing.id), sql`${products.metadata}->>'source' = 'medusa'`));
    await stampWebhookAt(db, tenantId);
    return { action: "updated", productId: existing.id };
  }

  const id = randomUUID();
  await db.insert(products).values({
    id,
    tenantId,
    // Deterministic SKU namespace — cannot collide with merchant-entered SKUs
    // and keeps the (tenantId, sku) unique index stable across replays.
    sku: `med:${medusaId}`.slice(0, 100),
    name: data.title,
    description: data.description ?? null,
    category: "medusa",
    price,
    currency,
    imageUrl: data.thumbnail ?? null,
    status: data.status === "published" || !data.status ? "active" : "inactive",
    stockQuantity: stock,
    metadata,
  }).onConflictDoNothing();
  await stampWebhookAt(db, tenantId);
  return { action: "created", productId: id };
}

async function stampWebhookAt(db: Db, tenantId: string): Promise<void> {
  await db
    .update(medusaStoreMappings)
    .set({ lastWebhookAt: new Date(), updatedAt: new Date() })
    .where(eq(medusaStoreMappings.tenantId, tenantId))
    .catch(() => {});
}

/**
 * Resolve which tenant a Medusa webhook event belongs to. The webhook is
 * registered per Medusa instance; tenants are disambiguated by (in order):
 *  1. data.metadata.platform_tenant_id (set by the outbound bridge),
 *  2. the mapping whose medusa_sales_channel_id appears in the payload,
 *  3. the mapping whose medusa_store_id matches data.metadata.store_id,
 *  4. null → caller rejects with 422 (never guess cross-tenant).
 */
export async function resolveTenantForMedusaEvent(
  db: Db,
  data: Record<string, any>,
): Promise<string | null> {
  const claimed = data?.metadata?.platform_tenant_id;
  if (typeof claimed === "string" && claimed) {
    const [row] = await db
      .select({ tenantId: medusaStoreMappings.tenantId })
      .from(medusaStoreMappings)
      .where(eq(medusaStoreMappings.tenantId, claimed))
      .limit(1)
      .catch(() => []);
    if (row) return row.tenantId;
  }
  const channelIds: string[] = Array.isArray(data?.sales_channels)
    ? data.sales_channels.map((c: any) => String(c?.id ?? ""))
    : [];
  const storeId = typeof data?.metadata?.store_id === "string" ? data.metadata.store_id : null;
  const rows = await db
    .select({
      tenantId: medusaStoreMappings.tenantId,
      salesChannelId: medusaStoreMappings.medusaSalesChannelId,
      medusaStoreId: medusaStoreMappings.medusaStoreId,
    })
    .from(medusaStoreMappings)
    .catch(() => []);
  for (const r of rows) {
    if (r.salesChannelId && channelIds.includes(r.salesChannelId)) return r.tenantId;
    if (storeId && r.medusaStoreId === storeId) return r.tenantId;
  }
  return null;
}

export interface BackfillResult {
  created: number;
  updated: number;
  total: number;
}

/**
 * Tenant-triggered full catalog pull. Iterates the adapter's product pages
 * and routes every product through the same idempotent upsert as webhooks,
 * so backfill ↔ webhook interleavings converge. Updates lastBackfillAt.
 */
export async function backfillMedusaCatalog(
  db: Db,
  tenantId: string,
  adapter: MedusaAdapter,
): Promise<BackfillResult> {
  let created = 0;
  let updated = 0;
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await adapter.listProducts({ limit, offset });
    for (const p of page.products) {
      const r = await handleMedusaProductEvent(db, tenantId, "product.created", p);
      if (r.action === "created") created++;
      else if (r.action === "updated") updated++;
    }
    offset += page.products.length;
    if (page.products.length < limit || offset >= page.count) break;
  }
  await db
    .update(medusaStoreMappings)
    .set({ lastBackfillAt: new Date(), updatedAt: new Date() })
    .where(eq(medusaStoreMappings.tenantId, tenantId))
    .catch(() => {});
  return { created, updated, total: created + updated };
}
