import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { merchantOnboardingProgress } from "../../drizzle/schema";
import { eq, count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";

export const onboardingProgressRouter = router({
  // Get current progress for the logged-in tenant
  getProgress: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId;
    if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated with this account" });

    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

    const [row] = await db
      .select()
      .from(merchantOnboardingProgress)
      .where(eq(merchantOnboardingProgress.tenantId, tenantId))
      .limit(1);

    if (!row) {
      return {
        tenantId,
        currentStep: 0,
        completedSteps: [] as number[],
        stepData: {} as Record<string, unknown>,
        isCompleted: false,
        completedAt: null as Date | null,
      };
    }

    return {
      tenantId: row.tenantId,
      currentStep: row.currentStep,
      completedSteps: (row.completedSteps as number[]) ?? [],
      stepData: (row.stepData as Record<string, unknown>) ?? {},
      isCompleted: row.isCompleted,
      completedAt: row.completedAt,
    };
  }),

  // Save progress (called on "Save and Continue Later" or step completion)
  saveProgress: protectedProcedure
    .input(z.object({
      currentStep: z.number().int().min(0).max(10),
      completedSteps: z.array(z.number().int()),
      stepData: z.record(z.string(), z.unknown()),
      isCompleted: z.boolean().optional().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated" });

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const now = new Date();
      const [existing] = await db
        .select({ id: merchantOnboardingProgress.id })
        .from(merchantOnboardingProgress)
        .where(eq(merchantOnboardingProgress.tenantId, tenantId))
        .limit(1);

      if (existing) {
        await db
          .update(merchantOnboardingProgress)
          .set({
            currentStep: input.currentStep,
            completedSteps: input.completedSteps,
            stepData: input.stepData,
            isCompleted: input.isCompleted,
            completedAt: input.isCompleted ? now : null,
            updatedAt: now,
          })
          .where(eq(merchantOnboardingProgress.tenantId, tenantId));
      } else {
        await db.insert(merchantOnboardingProgress).values({
          id: crypto.randomUUID(),
          tenantId,
          currentStep: input.currentStep,
          completedSteps: input.completedSteps,
          stepData: input.stepData,
          isCompleted: input.isCompleted,
          completedAt: input.isCompleted ? now : null,
          createdAt: now,
          updatedAt: now,
        });
      }

      return { success: true };
    }),

  // Reset wizard (start over)
  reset: protectedProcedure.mutation(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId;
    if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated" });

    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

    await db
      .update(merchantOnboardingProgress)
      .set({ currentStep: 0, completedSteps: [], stepData: {}, isCompleted: false, completedAt: null, updatedAt: new Date() })
      .where(eq(merchantOnboardingProgress.tenantId, tenantId));

    return { success: true };
  }),

  // Admin: funnel analytics — how many tenants are at each step
  getFunnelAnalytics: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const rows = await db
      .select({
        currentStep: merchantOnboardingProgress.currentStep,
        isCompleted: merchantOnboardingProgress.isCompleted,
        cnt: count(),
      })
      .from(merchantOnboardingProgress)
      .groupBy(merchantOnboardingProgress.currentStep, merchantOnboardingProgress.isCompleted);
    const STEP_LABELS = ["WhatsApp Setup", "Add Products", "Delivery Zones", "SLA Config", "Review"];
    const stepMap: Record<number, number> = {};
    let completedCount = 0;
    for (const row of rows) {
      if (row.isCompleted) {
        completedCount += Number(row.cnt);
      } else {
        stepMap[row.currentStep] = (stepMap[row.currentStep] ?? 0) + Number(row.cnt);
      }
    }
    const totalStarted = rows.reduce((s, r) => s + Number(r.cnt), 0);
    const funnel = STEP_LABELS.map((label, idx) => ({
      step: idx,
      label,
      count: stepMap[idx] ?? 0,
      dropOff: idx === 0 ? 0 : Math.max(0, (stepMap[idx - 1] ?? 0) - (stepMap[idx] ?? 0)),
    }));
    return { funnel, completedCount, totalStarted, completionRate: totalStarted > 0 ? Math.round((completedCount / totalStarted) * 100) : 0 };
  }),
});
