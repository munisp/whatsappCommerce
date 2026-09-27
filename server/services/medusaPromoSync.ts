// === W51 PROMOS ===
/**
 * medusaPromoSync.ts — push the W51 promo spotlight + most-ordered signals
 * to a tenant-linked Medusa v2 storefront.
 *
 *   - pushPromoToMedusa(tenantId, promo, action): upsert/delete a Medusa
 *     promotion mirroring a settings.promos write (routers/promos.ts).
 *     Idempotent: the promo object carries medusaPromotionId after the first
 *     successful create, so updates/deletes address the same remote row.
 *     Fixed-amount values are pushed as INTEGER CENTS (Medusa minor units).
 *     When the linked Medusa predates the promotions API (404), we degrade
 *     to tagging curated spotlight products via product metadata.
 *   - Fail-open with retry queue: unreachable Medusa never blocks a promo
 *     write — the op lands in an in-proc retry queue (drained on the next
 *     promo write) AND the promo is stamped medusaSyncPending so a later
 *     update re-attempts the push.
 *   - syncHighlightsToMedusa(db, tenantId): writes featured/popular signals
 *     into Medusa product metadata ({ featured, popular_rank, badge:
 *     "most_ordered" }) so storefront themes can badge/sort. Covers
 *     Medusa-imported products (products.metadata.medusaId is the link).
 */
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { products, tenants } from "../../drizzle/schema";
import type { Promo } from "./promos";
import { getMedusaIntegrationConfig, fetchJsonWithRetry } from "./integrationSync";
import { getPopularProducts, getPromoSpotSettings } from "./promoSpotlight";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface PromoMedusaFields {
  medusaPromotionId?: string;
  medusaSyncPending?: boolean;
}

interface PendingPush {
  tenantId: string;
  promo: Promo & PromoMedusaFields;
  action: "upsert" | "delete";
  queuedAt: number;
}

/** In-proc retry queue — drained on the next promo write for the tenant. */
const pendingQueue: PendingPush[] = [];

/** Test hook: inspect/wipe the pending retry queue. */
export function __pendingMedusaPushes(): PendingPush[] {
  return pendingQueue;
}
export function __clearPendingMedusaPushes(): void {
  pendingQueue.length = 0;
}

function headers(adminApiKey: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(adminApiKey ? { "x-medusa-access-token": adminApiKey } : {}),
  };
}

/** Medusa v2 promotion payload for a platform promo code. */
export function medusaPromotionPayload(promo: Promo): Record<string, unknown> {
  return {
    code: promo.code,
    type: "standard",
    status: "active",
    application_method: {
      // percent → percentage points; fixed → INTEGER minor units (cents).
      type: promo.type === "percent" ? "percentage" : "fixed",
      target_type: "order",
      allocation: "across",
      value: promo.type === "percent" ? Math.round(promo.value) : Math.round(promo.value * 100),
      ...(promo.maxUses != null ? { max_quantity: promo.maxUses } : {}),
    },
    ...(promo.expiresAt ? { ends_at: promo.expiresAt } : {}),
  };
}

export interface MedusaPushResult {
  /** Remote promotion id on success (null for delete). */
  medusaPromotionId?: string | null;
  /** True when the push failed and was queued for retry. */
  pending: boolean;
  /** "promotions" | "product_metadata" (degraded) | "not_linked" | "queued". */
  mode: "promotions" | "product_metadata" | "not_linked" | "queued";
}

/**
 * Mirror a promo write to the tenant's linked Medusa. Never throws.
 */
export async function pushPromoToMedusa(
  db: Db | null,
  tenantId: string,
  promo: Promo & PromoMedusaFields,
  action: "upsert" | "delete",
): Promise<MedusaPushResult> {
  const cfg = await getMedusaIntegrationConfig(tenantId).catch(() => null);
  if (!cfg?.baseUrl) return { pending: false, mode: "not_linked" };

  const label = `medusa promo ${action} tenant=${tenantId} code=${promo.code}`;
  try {
    if (action === "delete") {
      if (promo.medusaPromotionId) {
        const r = await fetchJsonWithRetry(
          `${cfg.baseUrl}/admin/promotions/${promo.medusaPromotionId}`,
          { method: "DELETE", headers: headers(cfg.adminApiKey) },
          { label },
        );
        if (r.ok) return { pending: false, mode: "promotions", medusaPromotionId: null };
        if (r.status !== 404) return queue(tenantId, promo, action);
      }
      // No remote id (or already gone) → nothing to delete remotely.
      return { pending: false, mode: "promotions", medusaPromotionId: null };
    }

    // upsert
    if (promo.medusaPromotionId) {
      const r = await fetchJsonWithRetry(
        `${cfg.baseUrl}/admin/promotions/${promo.medusaPromotionId}`,
        { method: "POST", headers: headers(cfg.adminApiKey), body: JSON.stringify(medusaPromotionPayload(promo)) },
        { label },
      );
      if (r.ok) return { pending: false, mode: "promotions", medusaPromotionId: promo.medusaPromotionId };
      if (r.status !== 404) return queue(tenantId, promo, action);
      // 404 on update → fall through to create (remote row vanished).
    }
    const r = await fetchJsonWithRetry(
      `${cfg.baseUrl}/admin/promotions`,
      { method: "POST", headers: headers(cfg.adminApiKey), body: JSON.stringify(medusaPromotionPayload(promo)) },
      { label },
    );
    if (r.ok) {
      const id = r.data?.promotion?.id ?? r.data?.id ?? null;
      return { pending: false, mode: "promotions", medusaPromotionId: id };
    }
    if (r.status === 404) {
      // Linked Medusa predates the promotions API → degrade to product
      // metadata/tag sync on the curated spotlight products.
      const degraded = await degradeToProductMetadata(db, tenantId, promo, cfg);
      return degraded
        ? { pending: false, mode: "product_metadata" }
        : queue(tenantId, promo, action);
    }
    return queue(tenantId, promo, action);
  } catch (e: any) {
    console.warn(`[medusaPromoSync] ${label} threw (fail-open):`, e?.message);
    return queue(tenantId, promo, action);
  }
}

function queue(tenantId: string, promo: Promo & PromoMedusaFields, action: "upsert" | "delete"): MedusaPushResult {
  // Dedupe: one pending op per (tenant, code) — latest write wins.
  const ix = pendingQueue.findIndex((p) => p.tenantId === tenantId && p.promo.code === promo.code);
  if (ix >= 0) pendingQueue.splice(ix, 1);
  pendingQueue.push({ tenantId, promo, action, queuedAt: Date.now() });
  return { pending: true, mode: "queued" };
}

/**
 * Drain queued promo pushes for a tenant (called before each new promo
 * write). Best-effort; ops that fail again stay queued.
 */
export async function drainMedusaPromoQueue(db: Db | null, tenantId: string): Promise<void> {
  const mine = pendingQueue.filter((p) => p.tenantId === tenantId);
  if (!mine.length) return;
  for (const p of mine) {
    const ix = pendingQueue.indexOf(p);
    if (ix >= 0) pendingQueue.splice(ix, 1);
    const r = await pushPromoToMedusa(db, tenantId, p.promo, p.action);
    if (r.pending) console.warn(`[medusaPromoSync] retry still pending code=${p.promo.code}`);
  }
}

/** Degraded sync: tag curated spotlight products with the promo code. */
async function degradeToProductMetadata(
  db: Db | null,
  tenantId: string,
  promo: Promo & PromoMedusaFields,
  cfg: { baseUrl: string; adminApiKey: string | null },
): Promise<boolean> {
  if (!db) return false;
  const [tenantRow] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const ids = getPromoSpotSettings(tenantRow?.settings ?? null).spotlightProductIds;
  if (!ids.length) return false;
  const rows = await db
    .select({ id: products.id, metadata: products.metadata })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), sql`${products.id} = ANY(${ids})`))
    .catch(() => [] as any[]);
  let pushed = false;
  for (const row of rows) {
    const medusaId = (row.metadata as any)?.medusaId;
    if (!medusaId) continue;
    const r = await fetchJsonWithRetry(
      `${cfg.baseUrl}/admin/products/${medusaId}`,
      {
        method: "POST",
        headers: headers(cfg.adminApiKey),
        body: JSON.stringify({ metadata: { promo_code: promo.code, promo_active: true } }),
      },
      { label: `medusa promo degrade tenant=${tenantId} code=${promo.code} product=${medusaId}` },
    );
    if (r.ok) pushed = true;
  }
  return pushed;
}

/**
 * Write featured/popular signals into Medusa product metadata so storefront
 * themes can badge/sort: { featured, popular_rank, badge: "most_ordered" }.
 * Only products with a Medusa link (metadata.medusaId — including
 * W50 Medusa-imported products) are touched. Never throws.
 */
export async function syncHighlightsToMedusa(db: Db, tenantId: string): Promise<{ synced: number }> {
  const cfg = await getMedusaIntegrationConfig(tenantId).catch(() => null);
  if (!cfg?.baseUrl) return { synced: 0 };
  const [tenantRow] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const spot = getPromoSpotSettings(tenantRow?.settings ?? null);
  const popular = await getPopularProducts(db, tenantId, 10);
  const rank = new Map(popular.map((r, i) => [r.productId, i + 1]));
  const featured = new Set(spot.featuredProductIds);
  const top3 = new Set(popular.slice(0, 3).map((r) => r.productId));
  const wanted = new Set<string>([...Array.from(rank.keys()), ...Array.from(featured)]);
  if (!wanted.size) return { synced: 0 };

  const rows = await db
    .select({ id: products.id, metadata: products.metadata })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), sql`${products.metadata}->>'medusaId' IS NOT NULL`))
    .catch(() => [] as any[]);
  let synced = 0;
  for (const row of rows) {
    if (!wanted.has(row.id)) continue;
    const medusaId = (row.metadata as any)?.medusaId;
    const metadata: Record<string, unknown> = {
      featured: featured.has(row.id),
      popular_rank: rank.get(row.id) ?? null,
      badge: top3.has(row.id) ? "most_ordered" : null,
    };
    const r = await fetchJsonWithRetry(
      `${cfg.baseUrl}/admin/products/${medusaId}`,
      { method: "POST", headers: headers(cfg.adminApiKey), body: JSON.stringify({ metadata }) },
      { label: `medusa highlights tenant=${tenantId} product=${row.id}` },
    );
    if (r.ok) synced += 1;
  }
  return { synced };
}
