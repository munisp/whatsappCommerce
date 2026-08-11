import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { cohortSnapshots, churnPredictions } from "../../drizzle/schema";
import { randomUUID } from "crypto";

export const analyticsBIRouter = router({
  // ── Cohort Analysis ──────────────────────────────────────────────────────
  listCohorts: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(12) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      return db.select().from(cohortSnapshots).where(eq(cohortSnapshots.tenantId, input.tenantId))
        .orderBy(desc(cohortSnapshots.cohortMonth)).limit(input.limit);
    }),

  upsertCohort: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      cohortMonth: z.string(), // "YYYY-MM"
      totalCustomers: z.number().int(),
      retentionByMonth: z.record(z.string(), z.number()),
      avgOrderValue: z.string().optional(),
      totalRevenue: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const now = new Date();
      // Select-then-insert/update: NO unique constraint exists on
      // (tenantId, cohortMonth), so onConflictDoUpdate would throw 42P10 on
      // every call (same bug class as the w11 registry upsert).
      const { and } = await import("drizzle-orm");
      const [existing] = await db
        .select({ id: cohortSnapshots.id })
        .from(cohortSnapshots)
        .where(and(eq(cohortSnapshots.tenantId, input.tenantId), eq(cohortSnapshots.cohortMonth, input.cohortMonth)))
        .limit(1);
      if (existing) {
        await db.update(cohortSnapshots)
          .set({ totalCustomers: input.totalCustomers, retentionByMonth: input.retentionByMonth, avgOrderValue: input.avgOrderValue, totalRevenue: input.totalRevenue, calculatedAt: now })
          .where(eq(cohortSnapshots.id, existing.id));
      } else {
        await db.insert(cohortSnapshots).values({ id: randomUUID(), ...input, calculatedAt: now });
      }
      return { ok: true };
    }),

  // ── Churn Predictions ────────────────────────────────────────────────────
  listChurnRisks: protectedProcedure
    .input(z.object({ tenantId: z.string(), riskLevel: z.enum(["high", "medium", "low"]).optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(churnPredictions.tenantId, input.tenantId)];
      if (input.riskLevel) conds.push(eq(churnPredictions.riskLevel, input.riskLevel));
      const { and } = await import("drizzle-orm");
      return db.select().from(churnPredictions).where(and(...conds)).orderBy(desc(churnPredictions.calculatedAt)).limit(input.limit);
    }),

  upsertChurnPrediction: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string(),
      churnScore: z.string(),
      riskLevel: z.enum(["high", "medium", "low"]),
      daysSinceLastOrder: z.number().int().optional(),
      predictedChurnDate: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const now = new Date();
      // Select-then-insert/update: NO unique constraint exists on
      // (tenantId, customerPhone) — onConflictDoUpdate would throw 42P10.
      const { and } = await import("drizzle-orm");
      const [existing] = await db
        .select({ id: churnPredictions.id })
        .from(churnPredictions)
        .where(and(eq(churnPredictions.tenantId, input.tenantId), eq(churnPredictions.customerPhone, input.customerPhone)))
        .limit(1);
      const patch = { churnScore: input.churnScore, riskLevel: input.riskLevel, daysSinceLastOrder: input.daysSinceLastOrder, calculatedAt: now };
      if (existing) {
        await db.update(churnPredictions).set(patch).where(eq(churnPredictions.id, existing.id));
      } else {
        await db.insert(churnPredictions).values({
          id: randomUUID(), ...input,
          predictedChurnDate: input.predictedChurnDate ? new Date(input.predictedChurnDate) : undefined,
          interventionSent: false, calculatedAt: now,
        });
      }
      return { ok: true };
    }),

  markInterventionSent: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      // No tenantId in input — resolve the row and assert on its tenant.
      const [row] = await db.select().from(churnPredictions).where(eq(churnPredictions.id, input.id)).limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Churn prediction not found" });
      assertTenantAccess(ctx.user, row.tenantId);
      await db.update(churnPredictions).set({ interventionSent: true }).where(eq(churnPredictions.id, input.id));
      return { ok: true };
    }),

  // ── BI Summary ───────────────────────────────────────────────────────────
  biSummary: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const cohorts = await db.select().from(cohortSnapshots).where(eq(cohortSnapshots.tenantId, input.tenantId)).orderBy(desc(cohortSnapshots.cohortMonth)).limit(6);
      const churnRisks = await db.select().from(churnPredictions).where(eq(churnPredictions.tenantId, input.tenantId));
      const highRisk = churnRisks.filter(c => c.riskLevel === "high").length;
      const mediumRisk = churnRisks.filter(c => c.riskLevel === "medium").length;
      const latestCohort = cohorts[0];
      return {
        latestCohortMonth: latestCohort?.cohortMonth ?? null,
        latestCohortCustomers: latestCohort?.totalCustomers ?? 0,
        latestRevenue: latestCohort?.totalRevenue ?? "0",
        avgOrderValue: latestCohort?.avgOrderValue ?? "0",
        churnHighRisk: highRisk,
        churnMediumRisk: mediumRisk,
        totalChurnTracked: churnRisks.length,
        cohortTrend: cohorts.map(c => ({ month: c.cohortMonth, customers: c.totalCustomers, revenue: c.totalRevenue })),
      };
    }),
});
