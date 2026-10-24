// === W64 intelligence (R1) ===
/**
 * Recommendations router — replaces the ml-stack /recommend stub slice with
 * real co-purchase + personalized reorder data from services/recsService.
 *
 *   - forProduct:    public (storefront product view) — "customers also
 *                    bought…" co-purchase pairs; graceful empty-state [].
 *   - forBuyer:      protected — the caller's own reorder suggestions from
 *                    their order history (tenant-scoped).
 *   - postPurchase:  protected — "also bought" recs for one of the caller's
 *                    orders (post-purchase follow-up surfaces).
 *
 * All procedures are fail-open: recs are telemetry-grade, never money-path;
 * a DB outage returns { recommendations: [] } instead of throwing.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { orders, users } from "../../drizzle/schema";
import {
  getCoPurchaseForProduct,
  getPostPurchaseRecs,
  getReorderSuggestionsForBuyer,
} from "../services/recsService";

export const recsRouter = router({
  /** Storefront: co-purchase recs for a product card (public, fail-open). */
  forProduct: publicProcedure
    .input(z.object({
      tenantId: z.string().min(1).max(36),
      productId: z.string().min(1).max(36),
      limit: z.number().int().min(1).max(10).default(4),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { recommendations: [] as const };
      const recs = await getCoPurchaseForProduct(db, input.tenantId, input.productId, input.limit);
      return { recommendations: recs };
    }),

  /** Buyer-personalized reorder suggestions from own order history. */
  forBuyer: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1).max(36),
      limit: z.number().int().min(1).max(10).default(4),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { recommendations: [] as const };
      // Buyers are keyed by phone in orders.customerId; staff fall back to id.
      const [me] = await db.select({ phone: users.phone }).from(users)
        .where(eq(users.id, ctx.user.id)).limit(1).catch(() => [] as any[]);
      const customerId = (me as any)?.phone ?? String(ctx.user.id);
      const recs = await getReorderSuggestionsForBuyer(db, input.tenantId, customerId, input.limit);
      return { recommendations: recs };
    }),

  /** Post-purchase recs for one of the caller's orders. */
  postPurchase: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1).max(36),
      orderId: z.string().min(1).max(36),
      limit: z.number().int().min(1).max(10).default(4),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { recommendations: [] as const };
      const [order] = await db.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.tenantId, input.tenantId)))
        .limit(1).catch(() => [] as any[]);
      if (!order) return { recommendations: [] as const };
      const recs = await getPostPurchaseRecs(db, input.tenantId, input.orderId, input.limit);
      return { recommendations: recs };
    }),
});
// === END W64 intelligence (R1) ===
