// === W54 capabilities (CAP-1) ===
/**
 * membershipPlans router — merchant-facing CRUD for consumer membership
 * tiers + member roster (tenant-guarded: protectedProcedure +
 * assertTenantAccess on every procedure, assertMoneyAccess on the
 * price-bearing mutations, mirroring the events router pattern).
 *
 * The buyer-facing surface (list plans / join / status / cancel) lives in
 * chat (routers/nlp.ts deterministic block, WA+TG parity) and USSD
 * (services/ussdBalances.ts read-only status) — NOT here.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  archiveMembershipPlan,
  createMembershipPlan,
  listMembershipPlans,
  listMembershipRoster,
  runMembershipExpirySweep,
  updateMembershipPlan,
} from "../services/membershipPlans";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const periodSchema = z.enum(["day", "week", "month"]);

export const membershipPlansRouter = router({
  createPlan: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      name: z.string().min(1).max(120),
      description: z.string().max(2000).nullish(),
      priceCents: z.number().int().min(0).max(1_000_000_000),
      currency: z.string().length(3).optional(),
      period: periodSchema,
      discountPercent: z.number().int().min(0).max(100).optional(),
      pointsMultiplier: z.number().int().min(1).max(10).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return createMembershipPlan(db, input);
    }),

  updatePlan: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      planId: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).nullish(),
      priceCents: z.number().int().min(0).max(1_000_000_000).optional(),
      period: periodSchema.optional(),
      discountPercent: z.number().int().min(0).max(100).optional(),
      pointsMultiplier: z.number().int().min(1).max(10).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return updateMembershipPlan(db, input);
    }),

  archivePlan: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), planId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return archiveMembershipPlan(db, input);
    }),

  listPlans: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      includeArchived: z.boolean().optional(),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return listMembershipPlans(db, input.tenantId, { includeArchived: input.includeArchived });
    }),

  /** Member roster (optionally filtered by plan/status). */
  roster: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      planId: z.string().uuid().optional(),
      status: z.enum(["active", "cancelled", "expired"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const rows = await listMembershipRoster(db, input.tenantId, input);
      return rows.map((r) => ({
        membershipId: r.membership.id,
        planId: r.membership.planId,
        planName: r.planName,
        customerId: r.membership.customerId,
        status: r.membership.status,
        startedAt: r.membership.startedAt,
        currentPeriodEnd: r.membership.currentPeriodEnd,
        cancelAtPeriodEnd: r.membership.cancelAtPeriodEnd,
      }));
    }),

  /** Manual expiry sweep trigger (cron also calls the service directly). */
  runExpirySweep: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return runMembershipExpirySweep(db);
    }),
});
// === END W54 capabilities ===
