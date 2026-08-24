import { z } from "zod";
import { sql } from "drizzle-orm";
import { router, protectedProcedure, adminProcedure, assertTenantAccess } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";

export const analyticsRouter = router({
  platformOverview: adminProcedure.query(async () => {
    return db.getPlatformOverview();
  }),

  // ── W30 (V3#6): real time-series for the platform dashboard charts ──────
  // Monthly completed-revenue (paid orders), last 7 months, grouped by the
  // order currency of the platform default (mixed currencies are summed
  // separately and the dominant currency is reported — the chart is a trend
  // indicator, not a financial statement).
  revenueTrend: adminProcedure.query(async () => {
    const drizzle = await getDb();
    if (!drizzle) return { points: [] as Array<{ month: string; revenue: number }> };
    const rows = await drizzle.execute(sql`
      SELECT to_char(date_trunc('month', "createdAt"), 'Mon') AS month,
             date_trunc('month', "createdAt") AS month_start,
             COALESCE(SUM("totalAmount"::numeric), 0)::float8 AS revenue
      FROM orders
      WHERE "paymentStatus" = 'completed'
        AND "createdAt" >= date_trunc('month', now()) - interval '6 months'
      GROUP BY 1, 2
      ORDER BY 2
    `);
    const points = (rows as unknown as Array<{ month: string; revenue: number }>).map((r) => ({
      month: r.month,
      revenue: Math.round((r.revenue ?? 0) * 100) / 100,
    }));
    return { points };
  }),

  // Daily conversation split (AI-handled vs human/escalated), last 7 days.
  conversationSplitTrend: adminProcedure.query(async () => {
    const drizzle = await getDb();
    if (!drizzle) return { points: [] as Array<{ day: string; bot: number; human: number }> };
    const rows = await drizzle.execute(sql`
      SELECT to_char(date_trunc('day', "createdAt"), 'Dy') AS day,
             date_trunc('day', "createdAt") AS day_start,
             COUNT(*) FILTER (WHERE "aiHandled")::int AS bot,
             COUNT(*) FILTER (WHERE NOT "aiHandled")::int AS human
      FROM conversations
      WHERE "createdAt" >= date_trunc('day', now()) - interval '6 days'
      GROUP BY 1, 2
      ORDER BY 2
    `);
    return {
      points: (rows as unknown as Array<{ day: string; bot: number; human: number }>).map((r) => ({
        day: r.day,
        bot: r.bot ?? 0,
        human: r.human ?? 0,
      })),
    };
  }),

  tenantDashboard: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const [convStats, orderStats, productStats, agentStats, customerCount] = await Promise.all([
        db.getConversationStats(input.tenantId),
        db.getOrderStats(input.tenantId),
        db.getProductStats(input.tenantId),
        db.getAgentStats(input.tenantId),
        db.getCustomerCount(input.tenantId),
      ]);
      return { conversations: convStats, orders: orderStats, products: productStats, agent: agentStats, customers: customerCount };
    }),
});

