/**
 * server/routers/crm.ts — W17 F11 CRM pipeline views on top of lead scoring.
 *
 * Twenty stays the CRM system of record; these views bucket the tenant's
 * customers by lead band + derived pipeline stage using the commerce-native
 * scores in customer_lead_scores (server/services/leadScoring.ts):
 *
 *   pipelineSummary  per-stage counts + total value, plus band distribution
 *   atRiskList       previously-hot buyers with no order in 30d+ (win-back)
 *   refreshScores    recompute scores for the tenant (idempotent upsert)
 *   createWinBackCampaign  one-click draft broadcast targeting the at-risk
 *                          segment (segmentFilter.noOrderSinceDays)
 *   getScoreBreakdown      explainable factor list for one customer
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, and } from "drizzle-orm";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { broadcastCampaigns, customerLeadScores, customers } from "../../drizzle/schema";
import {
  refreshLeadScores,
  LEAD_SCORE_WEIGHTS,
  type LeadBand,
  type LeadStage,
} from "../services/leadScoring";

export const LEAD_STAGES: LeadStage[] = ["new_lead", "engaged", "first_order", "repeat", "vip", "at_risk"];
export const LEAD_BANDS: LeadBand[] = ["hot", "warm", "cold"];

/** Pure bucketing helper (unit-tested without a DB). */
export function bucketPipeline(
  rows: { customerId: string; band: string; stage: string; score: number; totalSpent: number }[],
) {
  const stages = Object.fromEntries(
    LEAD_STAGES.map((s) => [s, { count: 0, totalValue: 0 }]),
  ) as Record<LeadStage, { count: number; totalValue: number }>;
  const bands = Object.fromEntries(LEAD_BANDS.map((b) => [b, 0])) as Record<LeadBand, number>;
  for (const r of rows) {
    const stage = (LEAD_STAGES as string[]).includes(r.stage) ? (r.stage as LeadStage) : "new_lead";
    stages[stage].count += 1;
    stages[stage].totalValue += r.totalSpent;
    if ((LEAD_BANDS as string[]).includes(r.band)) bands[r.band as LeadBand] += 1;
  }
  return { stages, bands, total: rows.length };
}

export const crmRouter = router({
  /**
   * Recompute this tenant's lead scores from commerce events. Idempotent
   * (upsert on tenantId+customerId).
   */
  refreshScores: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return refreshLeadScores(db, input.tenantId);
    }),

  /** Pipeline summary: customers bucketed by stage + band, with totals. */
  pipelineSummary: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({
          customerId: customerLeadScores.customerId,
          band: customerLeadScores.band,
          stage: customerLeadScores.stage,
          score: customerLeadScores.score,
          totalSpent: customers.totalSpent,
        })
        .from(customerLeadScores)
        .innerJoin(
          customers,
          and(eq(customers.id, customerLeadScores.customerId), eq(customers.tenantId, customerLeadScores.tenantId)),
        )
        .where(eq(customerLeadScores.tenantId, input.tenantId));
      return bucketPipeline(
        (rows as any[]).map((r) => ({
          customerId: r.customerId,
          band: r.band,
          stage: r.stage,
          score: r.score,
          totalSpent: Number(r.totalSpent ?? 0),
        })),
      );
    }),

  /**
   * Win-back candidates: customers who were previously hot buyers (≥2 orders
   * lifetime — they bought in before) but have not ordered in 30+ days.
   * Sourced from live order data so it works even before a score refresh.
   */
  atRiskList: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({
          customerId: customers.id,
          name: customers.name,
          whatsappPhone: customers.whatsappPhone,
          totalOrders: customers.totalOrders,
          totalSpent: customers.totalSpent,
          lastOrderAt: customers.lastOrderAt,
          score: customerLeadScores.score,
          band: customerLeadScores.band,
        })
        .from(customers)
        .leftJoin(
          customerLeadScores,
          and(eq(customerLeadScores.customerId, customers.id), eq(customerLeadScores.tenantId, customers.tenantId)),
        )
        .where(eq(customers.tenantId, input.tenantId))
        .orderBy(desc(customers.totalSpent))
        .limit(1000);
      const now = Date.now();
      return (rows as any[])
        .filter((r) => {
          if ((r.totalOrders ?? 0) < 2) return false; // previously active buyers only
          if (!r.lastOrderAt) return false;
          return now - new Date(r.lastOrderAt).getTime() >= 30 * 24 * 60 * 60 * 1000;
        })
        .slice(0, input.limit)
        .map((r) => ({
          customerId: r.customerId,
          name: r.name,
          whatsappPhone: r.whatsappPhone,
          totalOrders: r.totalOrders,
          totalSpent: Number(r.totalSpent ?? 0),
          lastOrderAt: r.lastOrderAt,
          daysSinceLastOrder: Math.floor((now - new Date(r.lastOrderAt).getTime()) / (24 * 60 * 60 * 1000)),
          score: r.score ?? null,
          band: r.band ?? null,
        }));
    }),

  /** Explainable score breakdown for one customer (factor list drawer). */
  getScoreBreakdown: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), customerId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [row] = await db
        .select()
        .from(customerLeadScores)
        .where(and(eq(customerLeadScores.tenantId, input.tenantId), eq(customerLeadScores.customerId, input.customerId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No score computed for this customer yet" });
      return {
        customerId: row.customerId,
        score: row.score,
        band: row.band,
        stage: row.stage,
        factors: (row.factors ?? []) as { factor: string; delta: number }[],
        computedAt: row.computedAt,
      };
    }),

  /**
   * One-click win-back: create a DRAFT broadcast campaign whose audience is
   * the at-risk segment (≥1 lifetime order, no order in 30+ days). The
   * merchant reviews/sends it from the normal broadcast flow — this only
   * creates the draft.
   */
  createWinBackCampaign: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        name: z.string().min(1).max(255).default("Win-back campaign"),
        noOrderSinceDays: z.number().int().min(1).max(3650).default(30),
        templateName: z.string().trim().min(1).max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const id = crypto.randomUUID();
      await db.insert(broadcastCampaigns).values({
        id,
        tenantId: input.tenantId,
        name: input.name,
        segment: "custom",
        segmentFilter: { minOrders: 1, noOrderSinceDays: input.noOrderSinceDays },
        varMapping: input.templateName ? { __templateName: input.templateName } : null,
        status: "draft",
        createdBy: ctx.user?.name ?? ctx.user?.openId ?? "system",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { id };
    }),
});

export { LEAD_SCORE_WEIGHTS };
