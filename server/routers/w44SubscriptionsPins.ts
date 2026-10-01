// === W44 deposits-subs-digital (Coder C): merchant tRPC surface ===
/**
 * w44 router — subscription plans + digital PIN batch upload.
 * Tenant-scoped (assertTenantAccess); state mutations re-assert
 * assertTenantActive inside the services. PINs are encrypted at rest with
 * the W42 keyring (v2:<kid>) inside services/digitalPins.ts — plaintext
 * arrives over TLS and is NEVER persisted or returned.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

export const subscriptionPlansRouter = router({
  createPlan: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      name: z.string().min(1).max(160),
      interval: z.enum(["day", "week", "month"]),
      priceCents: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { createSubscriptionPlan } = await import("../services/subscriptions");
      return createSubscriptionPlan(db, { ...input, actorId: String(ctx.user?.id ?? "merchant") });
    }),

  archivePlan: protectedProcedure
    .input(z.object({ tenantId: z.string(), planId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { archiveSubscriptionPlan } = await import("../services/subscriptions");
      return archiveSubscriptionPlan(db, input);
    }),

  listPlans: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { listSubscriptionPlans } = await import("../services/subscriptions");
      return listSubscriptionPlans(db, input.tenantId);
    }),

  // === W55 ui-a ===
  /** Subscriber list (additive, tenant-scoped read) for the tenant-portal
   *  SubscriptionPlans page — no existing procedure exposes the roster. */
  listSubscribers: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      planId: z.string().uuid().optional(),
      status: z.enum(["active", "paused", "cancelled", "past_due"]).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { customerSubscriptions, subscriptionPlans } = await import("../../drizzle/schema");
      const { and, desc, eq } = await import("drizzle-orm");
      const rows = await db.select({
        id: customerSubscriptions.id,
        planId: customerSubscriptions.planId,
        planName: subscriptionPlans.name,
        customerId: customerSubscriptions.customerId,
        status: customerSubscriptions.status,
        nextBillingAt: customerSubscriptions.nextBillingAt,
        lastBilledPeriod: customerSubscriptions.lastBilledPeriod,
        createdAt: customerSubscriptions.createdAt,
      }).from(customerSubscriptions)
        .innerJoin(subscriptionPlans, eq(customerSubscriptions.planId, subscriptionPlans.id))
        .where(and(
          eq(customerSubscriptions.tenantId, input.tenantId),
          input.planId ? eq(customerSubscriptions.planId, input.planId) : undefined,
          input.status ? eq(customerSubscriptions.status, input.status) : undefined,
        ))
        .orderBy(desc(customerSubscriptions.createdAt))
        .limit(input.limit);
      return rows;
    }),
  // === END W55 ui-a ===
});

export const digitalPinsRouter = router({
  /** Bulk PIN upload — encrypted at rest (v2:<kid>) before insert. */
  uploadBatch: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      pins: z.array(z.string().min(4).max(128)).min(1).max(5000),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { uploadPinBatch } = await import("../services/digitalPins");
      return uploadPinBatch(db, {
        tenantId: input.tenantId,
        productId: input.productId,
        uploadedBy: String(ctx.user?.openId ?? ctx.user?.id ?? "merchant"),
        pins: input.pins,
      });
    }),

  /** Stock snapshot for one digital product. */
  stock: protectedProcedure
    .input(z.object({ tenantId: z.string(), productId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { pinStockForProduct } = await import("../services/digitalPins");
      return pinStockForProduct(db, input.tenantId, input.productId);
    }),
});
