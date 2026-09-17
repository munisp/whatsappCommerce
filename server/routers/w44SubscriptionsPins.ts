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
