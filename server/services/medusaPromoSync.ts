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
import { and, asc, eq, lte, sql } from "drizzle-orm";
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

// === W60 persistence ===
// W60-A CRITICAL #2: the in-proc pendingQueue array is gone — failed pushes
// land in the medusa_promo_outbox table (migration 0180), deduped per
// (tenantId, promoCode, op) with latest-write-wins, and drained both on the
// next promo write (drainMedusaPromoQueue) and by the
// /api/scheduled/medusa-promo-outbox cron sweeper with bounded retry +
// exponential backoff. Fail-open per row: a failing op never blocks others.
import { medusaPromoOutbox } from "../../drizzle/schema";
import { captureException } from "./observability";

export const MAX_MEDUSA_OUTBOX_ATTEMPTS = 8;
/** Exponential backoff: 30s * 2^attempts, capped at 30 min. */
export function medusaOutboxBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts), 30 * 60_000);
}

/** Persist a failed push (idempotent upsert on the dedupe key). */
async function enqueueMedusaPromoOutbox(
  db: Db | null,
  tenantId: string,
  promo: Promo & PromoMedusaFields,
  action: "upsert" | "delete",
  lastError?: string,
): Promise<void> {
  if (!db) {
    console.warn(`[medusaPromoSync] no db — cannot persist outbox row code=${promo.code} (op lost)`);
    return;
  }
  const now = new Date();
  try {
    await db
      .insert(medusaPromoOutbox)
      .values({
        tenantId,
        promoCode: promo.code.slice(0, 64),
        op: action,
        payload: promo as unknown as Record<string, unknown>,
        status: "pending",
        attempts: 0,
        lastError: lastError?.slice(0, 500) ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [medusaPromoOutbox.tenantId, medusaPromoOutbox.promoCode, medusaPromoOutbox.op],
        set: {
          payload: promo as unknown as Record<string, unknown>,
          status: "pending",
          attempts: 0,
          lastError: lastError?.slice(0, 500) ?? null,
          updatedAt: now,
        },
      });
  } catch (e: any) {
    console.warn(`[medusaPromoSync] outbox enqueue failed (fail-open):`, e?.message);
  }
}
// === END W60 persistence ===

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
 * Raw push attempt against the tenant's linked Medusa. Never throws; a
 * failure returns { pending: true, mode: "queued" } WITHOUT persisting —
 * persistence is the caller's job (pushPromoToMedusa enqueues; the sweeper
 * records attempts on its own row).
 */
async function attemptMedusaPush(
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
        if (r.status !== 404) return { pending: true, mode: "queued" };
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
      if (r.status !== 404) return { pending: true, mode: "queued" };
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
        : { pending: true, mode: "queued" };
    }
    return { pending: true, mode: "queued" };
  } catch (e: any) {
    console.warn(`[medusaPromoSync] ${label} threw (fail-open):`, e?.message);
    return { pending: true, mode: "queued" };
  }
}

/**
 * Mirror a promo write to the tenant's linked Medusa. Never throws. On
 * failure the op is persisted to medusa_promo_outbox (idempotent upsert on
 * the (tenantId, promoCode, op) dedupe key — latest write wins) so a
 * restart never silently loses a storefront promo change.
 */
export async function pushPromoToMedusa(
  db: Db | null,
  tenantId: string,
  promo: Promo & PromoMedusaFields,
  action: "upsert" | "delete",
): Promise<MedusaPushResult> {
  const r = await attemptMedusaPush(db, tenantId, promo, action);
  if (r.pending) await enqueueMedusaPromoOutbox(db, tenantId, promo, action);
  return r;
}

export interface MedusaOutboxSweepResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Sweep pending outbox rows (one tenant, or ALL tenants when tenantId is
 * null — the cron sweeper path). Claim-first per row (guarded UPDATE
 * pending→pending bumping attempts so concurrent sweepers never double-send
 * the same row), exponential backoff via medusaOutboxBackoffMs, bounded
 * retries → 'failed' + CRITICAL capture at exhaustion. Fail-open per row.
 */
export async function sweepMedusaPromoOutbox(
  db: Db | null,
  tenantId: string | null,
  opts: { batch?: number; now?: Date } = {},
): Promise<MedusaOutboxSweepResult> {
  const result: MedusaOutboxSweepResult = { claimed: 0, sent: 0, retried: 0, failed: 0 };
  if (!db) return result;
  const now = opts.now ?? new Date();
  const batch = Math.max(1, opts.batch ?? 50);
  const due = await db
    .select()
    .from(medusaPromoOutbox)
    .where(tenantId
      ? and(eq(medusaPromoOutbox.status, "pending"), eq(medusaPromoOutbox.tenantId, tenantId))
      : eq(medusaPromoOutbox.status, "pending"))
    .orderBy(asc(medusaPromoOutbox.createdAt))
    .limit(batch)
    .catch(() => [] as any[]);
  for (const row of due ?? []) {
    // Claim-first per row (guarded UPDATE pending→pending bumping attempts)
    // with the backoff gate INSIDE the guard so concurrent sweepers never
    // double-send and not-yet-due rows are skipped.
    const cutoff = new Date(now.getTime() - medusaOutboxBackoffMs(Number(row.attempts ?? 0)));
    const claimed = await db
      .update(medusaPromoOutbox)
      .set({ attempts: sql`${medusaPromoOutbox.attempts} + 1`, updatedAt: now })
      .where(and(
        eq(medusaPromoOutbox.id, row.id),
        eq(medusaPromoOutbox.status, "pending"),
        lte(medusaPromoOutbox.updatedAt, cutoff),
      ))
      .returning({ id: medusaPromoOutbox.id })
      .catch(() => [] as any[]);
    if (!claimed?.length) continue; // backed-off or claimed concurrently
    result.claimed++;
    const promo = (row.payload ?? {}) as Promo & PromoMedusaFields;
    const action = (row.op === "delete" ? "delete" : "upsert") as "upsert" | "delete";
    try {
      const r = await attemptMedusaPush(db, row.tenantId, promo, action);
      if (!r.pending) {
        await db.update(medusaPromoOutbox)
          .set({ status: "sent", lastError: null, updatedAt: new Date() })
          .where(eq(medusaPromoOutbox.id, row.id));
        result.sent++;
        continue;
      }
      throw new Error("medusa push still unreachable");
    } catch (e: any) {
      const attempts = Number(row.attempts ?? 0) + 1;
      if (attempts >= MAX_MEDUSA_OUTBOX_ATTEMPTS) {
        await db.update(medusaPromoOutbox)
          .set({ status: "failed", lastError: String(e?.message ?? e).slice(0, 500), updatedAt: new Date() })
          .where(eq(medusaPromoOutbox.id, row.id));
        captureException(e, {
          service: "medusaPromoOutbox",
          operation: `sweep.${row.op}`,
          tenantId: row.tenantId,
          severity: "error",
          extra: { rowId: row.id, code: row.promoCode, attempts },
        });
        result.failed++;
      } else {
        await db.update(medusaPromoOutbox)
          .set({ lastError: String(e?.message ?? e).slice(0, 500), updatedAt: new Date() })
          .where(eq(medusaPromoOutbox.id, row.id));
        console.warn(`[medusaPromoSync] outbox retry pending code=${row.promoCode} attempts=${attempts}`);
        result.retried++;
      }
    }
  }
  return result;
}

/**
 * Drain queued promo pushes for a tenant (called before each new promo
 * write). Backwards-compatible wrapper over the durable outbox sweep; the
 * tenant's own writes bypass backoff by re-attempting immediately on the
 * next write, so force due rows only (backoff still applies).
 */
export async function drainMedusaPromoQueue(db: Db | null, tenantId: string): Promise<void> {
  await sweepMedusaPromoOutbox(db, tenantId);
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
