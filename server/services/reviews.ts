/**
 * server/services/reviews.ts — W27 purchase-verified reviews.
 *
 * Only customers with a completed/delivered order can review that merchant or
 * a product from that order — enforcement lives HERE (createReview), not in
 * the router, so every caller (WhatsApp flow, portal, public API) gets the
 * same guarantee.
 *
 * trustScore integration (geoDiscovery): geoDiscovery's ranking consumes a
 * per-tenant trustScore but the tenants table has no such column (W25 note).
 * This service computes review-driven trust signals and REGISTERS them with
 * geoDiscovery through its additive setTrustScoreProvider hook — geoDiscovery
 * itself is not rewritten. Score (0..100, deterministic):
 *   base 50 + avgRatingDelta × 15 + log-review-volume bonus − removal penalty
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { orders, reviews } from "../../drizzle/schema";
import { setTrustScoreProvider } from "./geoDiscovery";
import type { getDb } from "../db";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Check the phone holds a delivered order for the tenant (purchase proof). */
export async function hasVerifiedPurchase(
  db: Db,
  tenantId: string,
  customerPhone: string,
  orderId?: string,
): Promise<{ ok: boolean; order?: typeof orders.$inferSelect }> {
  const rows = await db.select().from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customerPhone),
      eq(orders.status, "delivered"),
      ...(orderId ? [eq(orders.id, orderId)] : []),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  return rows[0] ? { ok: true, order: rows[0] } : { ok: false };
}

/**
 * Create a purchase-verified review. Throws FORBIDDEN unless the reviewer has
 * a delivered order with this merchant; when orderId+productId are given the
 * product must appear in that order's items. One review per
 * (tenant, order, product) — repeats upsert the rating (buyer correcting
 * their review) rather than stacking duplicates.
 */
export async function createReview(
  db: Db,
  input: {
    tenantId: string;
    customerPhone: string;
    rating: number;
    text?: string | null;
    orderId?: string;
    productId?: string | null;
  },
): Promise<typeof reviews.$inferSelect> {
  const rating = Math.floor(input.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "rating must be an integer 1–5" });
  }
  const proof = await hasVerifiedPurchase(db, input.tenantId, input.customerPhone, input.orderId);
  if (!proof.ok || !proof.order) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only customers with a completed (delivered) order can review this merchant.",
    });
  }
  const order = proof.order;
  const productId = (input.productId ?? "").trim();
  if (productId) {
    const items = Array.isArray(order.items) ? (order.items as Array<{ productId?: string }>) : [];
    if (!items.some((i) => i?.productId === productId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That product was not part of your delivered order." });
    }
  }

  const [existing] = await db.select().from(reviews)
    .where(and(
      eq(reviews.tenantId, input.tenantId),
      eq(reviews.orderId, order.id),
      eq(reviews.productId, productId),
    )).limit(1);
  if (existing) {
    if (existing.customerPhone !== input.customerPhone) {
      throw new TRPCError({ code: "FORBIDDEN", message: "A review for this order already exists." });
    }
    const [updated] = await db.update(reviews).set({
      rating,
      text: input.text?.slice(0, 2000) ?? existing.text,
      status: "published",
      updatedAt: new Date(),
    }).where(eq(reviews.id, existing.id)).returning();
    return updated!;
  }

  const [row] = await db.insert(reviews).values({
    tenantId: input.tenantId,
    orderId: order.id,
    productId,
    customerPhone: input.customerPhone,
    rating,
    text: input.text?.slice(0, 2000) ?? null,
    status: "published",
  }).returning();
  return row!;
}

/** Merchant response to a review (one per review; re-responding overwrites). */
export async function respondToReview(
  db: Db,
  tenantId: string,
  reviewId: string,
  response: string,
): Promise<typeof reviews.$inferSelect> {
  const [row] = await db.select().from(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.tenantId, tenantId))).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Review not found" });
  const [updated] = await db.update(reviews).set({
    merchantResponse: response.slice(0, 2000),
    respondedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(reviews.id, reviewId)).returning();
  return updated!;
}

/** Moderate (flag/remove/restore) a review. */
export async function moderateReview(
  db: Db,
  tenantId: string,
  reviewId: string,
  status: "published" | "flagged" | "removed",
): Promise<typeof reviews.$inferSelect> {
  const [updated] = await db.update(reviews).set({ status, updatedAt: new Date() })
    .where(and(eq(reviews.id, reviewId), eq(reviews.tenantId, tenantId))).returning();
  if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Review not found" });
  return updated;
}

/** Aggregate rating for a merchant (published reviews only). */
export async function getMerchantRating(
  db: Db,
  tenantId: string,
): Promise<{ avg: number; count: number }> {
  const [row] = await db.select({
    avg: sql<string>`COALESCE(AVG(${reviews.rating}), 0)`,
    count: sql<string>`COUNT(*)`,
  }).from(reviews)
    .where(and(eq(reviews.tenantId, tenantId), eq(reviews.status, "published")))
    .catch(() => []);
  return { avg: Number(row?.avg ?? 0), count: Number(row?.count ?? 0) };
}

/** List reviews for the portal moderation queue / storefront display. */
export async function listReviews(
  db: Db,
  tenantId: string,
  opts: { productId?: string; status?: string; limit?: number } = {},
) {
  return db.select().from(reviews)
    .where(and(
      eq(reviews.tenantId, tenantId),
      ...(opts.productId != null ? [eq(reviews.productId, opts.productId)] : []),
      ...(opts.status ? [eq(reviews.status, opts.status)] : []),
    ))
    .orderBy(desc(reviews.createdAt))
    .limit(Math.min(200, opts.limit ?? 50));
}

// ─── trustScore integration ──────────────────────────────────────────────────
/**
 * Deterministic review-driven trust score, 0..100:
 *   50 base
 *   + (avgRating − 3) × 15          (5★ → +30, 1★ → −30)
 *   + min(count, 20) × 1            (volume, capped)
 *   − removedCount × 5              (moderation penalty)
 * Clamped to [0, 100]. No reviews → null (geoDiscovery treats as 0/unknown).
 */
export function computeReviewTrustScorePure(stats: {
  avgRating: number;
  publishedCount: number;
  removedCount: number;
}): number | null {
  if (stats.publishedCount === 0) return null;
  const score = 50
    + (stats.avgRating - 3) * 15
    + Math.min(stats.publishedCount, 20)
    - stats.removedCount * 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Batch trust scores for a set of tenants (geoDiscovery provider shape). */
export async function getReviewTrustScores(
  tenantIds: string[],
  db: Db,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tenantIds.length === 0) return out;
  const rows = await db.select({
    tenantId: reviews.tenantId,
    status: reviews.status,
    avg: sql<string>`AVG(${reviews.rating})`,
    count: sql<string>`COUNT(*)`,
  }).from(reviews)
    .where(inArray(reviews.tenantId, tenantIds))
    .groupBy(reviews.tenantId, reviews.status)
    .catch(() => []);
  const stats = new Map<string, { avg: number; published: number; removed: number }>();
  for (const r of rows) {
    const s = stats.get(r.tenantId) ?? { avg: 0, published: 0, removed: 0 };
    if (r.status === "published") {
      s.avg = Number(r.avg);
      s.published = Number(r.count);
    } else if (r.status === "removed") {
      s.removed = Number(r.count);
    }
    stats.set(r.tenantId, s);
  }
  for (const [tid, s] of Array.from(stats.entries())) {
    const score = computeReviewTrustScorePure({
      avgRating: s.avg,
      publishedCount: s.published,
      removedCount: s.removed,
    });
    if (score != null) out.set(tid, score);
  }
  return out;
}

/**
 * Register the review-driven trust score with geoDiscovery's additive hook.
 * Called once from router registration; idempotent.
 */
export function registerReviewTrustScoreProvider(): void {
  setTrustScoreProvider((tenantIds, db) => getReviewTrustScores(tenantIds, db as Db));
}
