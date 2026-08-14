import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { broadcastAbTests, broadcastCampaigns } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

export const broadcastAbRouter = router({
  // ── Create A/B test for a campaign ─────────────────────────────────────────
  createAbTest: protectedProcedure
    .input(z.object({
      campaignId: z.string(),
      tenantId: z.string(),
      variantATemplateId: z.string(),
      variantBTemplateId: z.string(),
      variantAName: z.string().default("Variant A"),
      variantBName: z.string().default("Variant B"),
      splitRatio: z.number().min(10).max(90).default(50),
      winnerCriteria: z.enum(["read_rate", "delivery_rate", "click_rate"]).default("read_rate"),
      testDurationHours: z.number().default(24),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const id = randomUUID();
      const testEndAt = new Date(Date.now() + input.testDurationHours * 60 * 60 * 1000);
      await db.insert(broadcastAbTests).values({
        id,
        campaignId: input.campaignId,
        tenantId: input.tenantId,
        variantATemplateId: input.variantATemplateId,
        variantBTemplateId: input.variantBTemplateId,
        variantAName: input.variantAName,
        variantBName: input.variantBName,
        splitRatio: input.splitRatio,
        winnerCriteria: input.winnerCriteria,
        testEndAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Mark campaign as A/B test
      await db.update(broadcastCampaigns)
        .set({ isAbTest: true, abTestId: id, updatedAt: new Date() })
        .where(eq(broadcastCampaigns.id, input.campaignId));
      return { id, testEndAt };
    }),

  // ── Get A/B test results ────────────────────────────────────────────────────
  getAbResults: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db.select().from(broadcastAbTests)
        .where(eq(broadcastAbTests.campaignId, input.campaignId))
        .limit(1);
      if (!rows[0]) return null;
      const t = rows[0];
      // A2-04: results are tenant-confidential — scope to the owning tenant.
      assertTenantAccess(ctx.user, t.tenantId);
      const aReadRate = t.variantASent > 0 ? (t.variantARead / t.variantASent) * 100 : 0;
      const bReadRate = t.variantBSent > 0 ? (t.variantBRead / t.variantBSent) * 100 : 0;
      const aDeliveryRate = t.variantASent > 0 ? (t.variantADelivered / t.variantASent) * 100 : 0;
      const bDeliveryRate = t.variantBSent > 0 ? (t.variantBDelivered / t.variantBSent) * 100 : 0;
      return {
        ...t,
        variantAReadRate: Math.round(aReadRate * 10) / 10,
        variantBReadRate: Math.round(bReadRate * 10) / 10,
        variantADeliveryRate: Math.round(aDeliveryRate * 10) / 10,
        variantBDeliveryRate: Math.round(bDeliveryRate * 10) / 10,
        isComplete: t.testEndAt ? new Date() > new Date(t.testEndAt) : false,
        hasWinner: !!t.winnerVariant,
      };
    }),

  // ── Select winner manually ──────────────────────────────────────────────────
  selectWinner: protectedProcedure
    .input(z.object({
      abTestId: z.string(),
      winnerVariant: z.enum(["A", "B"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // A2-03: load-then-assert — the A/B test belongs to the caller's tenant.
      const rows = await db.select().from(broadcastAbTests)
        .where(eq(broadcastAbTests.id, input.abTestId)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "A/B test not found" });
      assertTenantAccess(ctx.user, rows[0].tenantId);
      await db.update(broadcastAbTests)
        .set({ winnerVariant: input.winnerVariant, updatedAt: new Date() })
        .where(eq(broadcastAbTests.id, input.abTestId));
      return { success: true };
    }),

  // ── Auto-select winner based on criteria ───────────────────────────────────
  autoSelectWinner: protectedProcedure
    .input(z.object({ abTestId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const rows = await db.select().from(broadcastAbTests)
        .where(eq(broadcastAbTests.id, input.abTestId)).limit(1);
      const t = rows[0];
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "A/B test not found" });
      // A2-03: load-then-assert — the A/B test belongs to the caller's tenant.
      assertTenantAccess(ctx.user, t.tenantId);
      let winner: "A" | "B";
      if (t.winnerCriteria === "read_rate") {
        const aRate = t.variantASent > 0 ? t.variantARead / t.variantASent : 0;
        const bRate = t.variantBSent > 0 ? t.variantBRead / t.variantBSent : 0;
        winner = aRate >= bRate ? "A" : "B";
      } else {
        const aRate = t.variantASent > 0 ? t.variantADelivered / t.variantASent : 0;
        const bRate = t.variantBSent > 0 ? t.variantBDelivered / t.variantBSent : 0;
        winner = aRate >= bRate ? "A" : "B";
      }
      await db.update(broadcastAbTests)
        .set({ winnerVariant: winner, updatedAt: new Date() })
        .where(eq(broadcastAbTests.id, input.abTestId));
      return { winner, success: true };
    }),

  // ── List all A/B tests for a tenant ────────────────────────────────────────
  listAbTests: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      // A2-04: unauthenticated cross-tenant enumeration hole — require auth + tenant access.
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(broadcastAbTests)
        .where(eq(broadcastAbTests.tenantId, input.tenantId));
    }),
});
