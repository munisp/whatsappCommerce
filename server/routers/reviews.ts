/**
 * server/routers/reviews.ts — W27 verified reviews router.
 *
 * Merchant procedures are tenant-guarded. Buyer review submission from the
 * WhatsApp prompt runs through the NLP pipeline (service-level createReview).
 * submitByToken is a hardened publicProcedure (tracking.ts exemplar): the
 * HMAC tracking token proves the buyer received the order; purchase
 * verification is enforced again in the service.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { orders } from "../../drizzle/schema";
import { verifyTrackingToken } from "../services/trackingToken";
import {
  createReview,
  getMerchantRating,
  listReviews,
  moderateReview,
  registerReviewTrustScoreProvider,
  respondToReview,
} from "../services/reviews";

// W27: feed review-driven trustScore into geoDiscovery ranking (additive hook).
registerReviewTrustScoreProvider();

export const reviewsRouter = router({
  /** Tenant review list (moderation queue). */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string().max(36).optional(),
      status: z.enum(["published", "flagged", "removed"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return listReviews(db, input.tenantId, input);
    }),

  /** Merchant rating aggregate. */
  summary: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { avg: 0, count: 0 };
      return getMerchantRating(db, input.tenantId);
    }),

  /** Merchant responds to a review. */
  respond: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      reviewId: z.string(),
      response: z.string().min(1).max(2000),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return respondToReview(db, input.tenantId, input.reviewId, input.response);
    }),

  /** Merchant moderates (flag/remove/restore). */
  moderate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      reviewId: z.string(),
      status: z.enum(["published", "flagged", "removed"]),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return moderateReview(db, input.tenantId, input.reviewId, input.status);
    }),

  /**
   * Public buyer review submission by HMAC tracking token (tracking.ts
   * exemplar). The token identifies the order; the reviewer is bound to the
   * order's customer phone so one buyer cannot review under another identity,
   * and the service enforces the delivered-order purchase check.
   */
  submitByToken: publicProcedure
    .input(z.object({
      token: z.string().min(10).max(128),
      rating: z.number().int().min(1).max(5),
      text: z.string().max(2000).optional(),
      productId: z.string().max(36).optional(),
    }))
    .mutation(async ({ input }) => {
      const orderId = verifyTrackingToken(input.token);
      if (!orderId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired tracking link" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      const review = await createReview(db, {
        tenantId: order.tenantId,
        customerPhone: order.customerId,
        rating: input.rating,
        text: input.text ?? null,
        orderId: order.id,
        productId: input.productId ?? null,
      });
      // Minimal echo — no customer PII back on a public endpoint.
      return { id: review.id, rating: review.rating, status: review.status };
    }),
});
