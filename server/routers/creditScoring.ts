// === W56 credit ===
/**
 * creditScoring router — tenant-scoped buyer/merchant credit-score views
 * over services/creditScoring.ts (W56). Read-only advisory: nothing here
 * blocks any existing flow.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { protectedProcedure, adminProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { creditScores } from "../../drizzle/schema";
import {
  computeAndStoreSubjectScore,
  getStoredSubjectScore,
  runCreditScoreRefreshSweep,
  type SubjectType,
} from "../services/creditScoring";

const subjectType = z.enum(["buyer", "merchant"]);

export const creditScoringRouter = router({
  /** Latest computed scores for the tenant (buyers + merchants). */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      subjectType: subjectType.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const where = input.subjectType
        ? and(eq(creditScores.tenantId, input.tenantId), eq(creditScores.subjectType, input.subjectType))
        : eq(creditScores.tenantId, input.tenantId);
      return db
        .select()
        .from(creditScores)
        .where(where)
        .orderBy(desc(creditScores.updatedAt))
        .limit(input.limit ?? 50);
    }),

  /** Single subject score + factor breakdown (recomputes when absent). */
  getSubject: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      subjectType,
      subjectId: z.string().min(1),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const stored = await getStoredSubjectScore(db, input.tenantId, input.subjectType, input.subjectId);
      if (stored) return { stored: true, ...stored };
      const fresh = await computeAndStoreSubjectScore(db, input.tenantId, input.subjectType, input.subjectId);
      if (!fresh) throw new TRPCError({ code: "NOT_FOUND", message: "Subject not found" });
      return {
        stored: false,
        tenantId: input.tenantId,
        subjectType: input.subjectType as SubjectType,
        subjectId: input.subjectId,
        score: fresh.score,
        grade: fresh.grade,
        factors: fresh.factors,
        computedAt: fresh.computedAt,
        version: fresh.version,
      };
    }),

  /** Recompute-now action (tenant admin). */
  recompute: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      subjectType,
      subjectId: z.string().min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const fresh = await computeAndStoreSubjectScore(db, input.tenantId, input.subjectType, input.subjectId);
      if (!fresh) throw new TRPCError({ code: "NOT_FOUND", message: "Subject not found" });
      return fresh;
    }),

  /** Platform-admin portfolio view: grade distribution across tenants. */
  portfolio: adminProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({
          subjectType: creditScores.subjectType,
          grade: creditScores.grade,
          n: creditScores.id,
        })
        .from(creditScores)
        .where(eq(creditScores.tenantId, input.tenantId));
      const byGrade: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
      for (const r of rows as any[]) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1;
      return { tenantId: input.tenantId, total: rows.length, byGrade };
    }),

  /** Admin-triggered stale-score sweep (same core as the cron route). */
  sweepNow: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return runCreditScoreRefreshSweep(db, { limit: input.limit });
    }),
});
