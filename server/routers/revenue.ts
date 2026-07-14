import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paymentTransactions, tenants, paymentGatewayConfigs } from "../../drizzle/schema";
import { eq, gte, and, sql, desc, count } from "drizzle-orm";

// Revenue share rates (profit-sharing model)
const PLATFORM_REVENUE_SHARE = 0.05;   // 5% of tenant net profit
const TXN_PROCESSING_COST_RATE = 0.015; // 1.5% Paystack/Flutterwave fee
const PLATFORM_TXN_SHARE = 0.002;       // 0.2% platform transaction cut

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function monthsAgo(n: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return startOfMonth(d);
}

export const revenueRouter = router({
  // ── Summary KPIs ────────────────────────────────────────────────────────────
  summary: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return null;

    const now = new Date();
    const thisMonthStart = startOfMonth(now);
    const lastMonthStart = monthsAgo(1);
    const last30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

    // Total GMV this month
    const [gmvRow] = await db
      .select({ gmv: sql<string>`COALESCE(SUM(amount), 0)` })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.status, "success"),
          gte(paymentTransactions.createdAt, thisMonthStart)
        )
      );

    // Total GMV last month
    const [gmvLastRow] = await db
      .select({ gmv: sql<string>`COALESCE(SUM(amount), 0)` })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.status, "success"),
          gte(paymentTransactions.createdAt, lastMonthStart),
          sql`${paymentTransactions.createdAt} < ${thisMonthStart}`
        )
      );

    // Transaction counts
    const [txnRow] = await db
      .select({ total: count(), success: sql<string>`COUNT(*) FILTER (WHERE status = 'success')` })
      .from(paymentTransactions)
      .where(gte(paymentTransactions.createdAt, last30));

    // Active tenants (have at least one transaction in last 30 days)
    const [activeTenantRow] = await db
      .select({ cnt: sql<string>`COUNT(DISTINCT "tenantId")` })
      .from(paymentTransactions)
      .where(gte(paymentTransactions.createdAt, last30));

    // Total tenants
    const [totalTenantRow] = await db.select({ cnt: count() }).from(tenants);

    const gmvThisMonth = parseFloat(gmvRow?.gmv ?? "0");
    const gmvLastMonth = parseFloat(gmvLastRow?.gmv ?? "0");
    const txnTotal = Number(txnRow?.total ?? 0);
    const txnSuccess = Number(txnRow?.success ?? 0);

    // Platform revenue = 0.2% txn share + estimated 5% profit share
    // Estimated tenant net profit = GMV * (1 - 1.5% processing - ~40% COGS)
    const estimatedTenantNetProfit = gmvThisMonth * (1 - TXN_PROCESSING_COST_RATE - 0.40);
    const platformProfitShare = estimatedTenantNetProfit * PLATFORM_REVENUE_SHARE;
    const platformTxnRevenue = gmvThisMonth * PLATFORM_TXN_SHARE;
    const totalPlatformRevenue = platformProfitShare + platformTxnRevenue;

    const gmvGrowth = gmvLastMonth > 0
      ? ((gmvThisMonth - gmvLastMonth) / gmvLastMonth) * 100
      : 0;

    return {
      gmvThisMonth,
      gmvLastMonth,
      gmvGrowthPct: Math.round(gmvGrowth * 10) / 10,
      totalPlatformRevenue,
      platformProfitShare,
      platformTxnRevenue,
      txnTotal,
      txnSuccess,
      txnSuccessRate: txnTotal > 0 ? Math.round((txnSuccess / txnTotal) * 1000) / 10 : 0,
      activeTenants: Number(activeTenantRow?.cnt ?? 0),
      totalTenants: Number(totalTenantRow?.cnt ?? 0),
      profitShareRate: PLATFORM_REVENUE_SHARE,
      txnShareRate: PLATFORM_TXN_SHARE,
    };
  }),

  // ── Monthly trend (last N months) ───────────────────────────────────────────
  monthlyTrend: protectedProcedure
    .input(z.object({ months: z.number().int().min(3).max(24).default(12) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const since = monthsAgo(input.months);
      const rows = await db
        .select({
          month: sql<string>`TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM')`,
          gmv: sql<string>`COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0)`,
          txnCount: sql<string>`COUNT(*) FILTER (WHERE status = 'success')`,
          failedCount: sql<string>`COUNT(*) FILTER (WHERE status = 'failed')`,
        })
        .from(paymentTransactions)
        .where(gte(paymentTransactions.createdAt, since))
        .groupBy(sql`DATE_TRUNC('month', "createdAt")`)
        .orderBy(sql`DATE_TRUNC('month', "createdAt")`);

      return rows.map((r) => {
        const gmv = parseFloat(r.gmv);
        const tenantNetProfit = gmv * (1 - TXN_PROCESSING_COST_RATE - 0.40);
        const platformRevenue =
          tenantNetProfit * PLATFORM_REVENUE_SHARE + gmv * PLATFORM_TXN_SHARE;
        return {
          month: r.month,
          gmv,
          txnCount: Number(r.txnCount),
          failedCount: Number(r.failedCount),
          platformRevenue: Math.round(platformRevenue * 100) / 100,
          platformProfitShare: Math.round(tenantNetProfit * PLATFORM_REVENUE_SHARE * 100) / 100,
          platformTxnRevenue: Math.round(gmv * PLATFORM_TXN_SHARE * 100) / 100,
        };
      });
    }),

  // ── Per-tenant revenue breakdown ────────────────────────────────────────────
  tenantBreakdown: protectedProcedure
    .input(z.object({ limit: z.number().int().min(5).max(100).default(20) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const since = monthsAgo(1);
      const rows = await db
        .select({
          tenantId: paymentTransactions.tenantId,
          gmv: sql<string>`COALESCE(SUM(amount) FILTER (WHERE ${paymentTransactions.status} = 'success'), 0)`,
          txnCount: sql<string>`COUNT(*) FILTER (WHERE ${paymentTransactions.status} = 'success')`,
          businessName: tenants.name,
        })
        .from(paymentTransactions)
        .leftJoin(tenants, eq(paymentTransactions.tenantId, tenants.id))
        .where(gte(paymentTransactions.createdAt, since))
        .groupBy(paymentTransactions.tenantId, tenants.name)
        .orderBy(desc(sql`SUM(amount) FILTER (WHERE ${paymentTransactions.status} = 'success')`))
        .limit(input.limit);

      return rows.map((r) => {
        const gmv = parseFloat(r.gmv);
        const tenantNetProfit = gmv * (1 - TXN_PROCESSING_COST_RATE - 0.40);
        const platformRevenue =
          tenantNetProfit * PLATFORM_REVENUE_SHARE + gmv * PLATFORM_TXN_SHARE;
        return {
          tenantId: r.tenantId,
          businessName: r.businessName ?? `Tenant ${r.tenantId.slice(0, 8)}`,
          gmv,
          txnCount: Number(r.txnCount),
          platformRevenue: Math.round(platformRevenue * 100) / 100,
          profitShareRevenue: Math.round(tenantNetProfit * PLATFORM_REVENUE_SHARE * 100) / 100,
          txnRevenue: Math.round(gmv * PLATFORM_TXN_SHARE * 100) / 100,
          effectiveRate: gmv > 0 ? Math.round((platformRevenue / gmv) * 10000) / 100 : 0,
        };
      });
    }),

  // ── Revenue forecast (linear regression on monthly trend) ──────────────────
  forecast: protectedProcedure
    .input(z.object({ horizonMonths: z.number().int().min(1).max(12).default(6) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { historical: [], forecast: [] };
      const since = monthsAgo(12);
      const rows = await db
        .select({
          month: sql<string>`TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM')`,
          gmv: sql<string>`COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0)`,
        })
        .from(paymentTransactions)
        .where(gte(paymentTransactions.createdAt, since))
        .groupBy(sql`DATE_TRUNC('month', "createdAt")`)
        .orderBy(sql`DATE_TRUNC('month', "createdAt")`);

      const historical = rows.map((r, i) => {
        const gmv = parseFloat(r.gmv);
        const netProfit = gmv * (1 - TXN_PROCESSING_COST_RATE - 0.40);
        return {
          month: r.month,
          gmv,
          platformRevenue: Math.round((netProfit * PLATFORM_REVENUE_SHARE + gmv * PLATFORM_TXN_SHARE) * 100) / 100,
          index: i,
        };
      });

      // Simple ordinary least-squares linear regression on platform revenue
      const n = historical.length;
      if (n < 2) return { historical, forecast: [] };
      const xs = historical.map((_, i) => i);
      const ys = historical.map((h) => h.platformRevenue);
      const xMean = xs.reduce((a, b) => a + b, 0) / n;
      const yMean = ys.reduce((a, b) => a + b, 0) / n;
      const slope = xs.reduce((acc, x, i) => acc + (x - xMean) * (ys[i] - yMean), 0) /
        xs.reduce((acc, x) => acc + (x - xMean) ** 2, 0);
      const intercept = yMean - slope * xMean;

      // GMV slope for forecast
      const gmvYs = historical.map((h) => h.gmv);
      const gmvMean = gmvYs.reduce((a, b) => a + b, 0) / n;
      const gmvSlope = xs.reduce((acc, x, i) => acc + (x - xMean) * (gmvYs[i] - gmvMean), 0) /
        xs.reduce((acc, x) => acc + (x - xMean) ** 2, 0);
      const gmvIntercept = gmvMean - gmvSlope * xMean;

      // Project future months
      const lastDate = new Date();
      const forecast = Array.from({ length: input.horizonMonths }, (_, k) => {
        const futureIdx = n + k;
        const d = new Date(lastDate.getFullYear(), lastDate.getMonth() + k + 1, 1);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const projectedRevenue = Math.max(0, Math.round((intercept + slope * futureIdx) * 100) / 100);
        const projectedGmv = Math.max(0, Math.round((gmvIntercept + gmvSlope * futureIdx) * 100) / 100);
        return { month, platformRevenue: projectedRevenue, gmv: projectedGmv, isForecast: true };
      });

      return { historical, forecast };
    }),

  // ── GMV growth leaderboard ──────────────────────────────────────────────────
  gmvLeaderboard: protectedProcedure
    .input(z.object({ limit: z.number().int().min(5).max(50).default(15) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const thisMonthStart = startOfMonth(new Date());
      const lastMonthStart = monthsAgo(1);

      // This month GMV per tenant
      const thisMonth = await db
        .select({
          tenantId: paymentTransactions.tenantId,
          gmv: sql<string>`COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0)`,
          txnCount: sql<string>`COUNT(*) FILTER (WHERE status = 'success')`,
          businessName: tenants.name,
          cogsRate: tenants.cogsRate,
        })
        .from(paymentTransactions)
        .leftJoin(tenants, eq(paymentTransactions.tenantId, tenants.id))
        .where(gte(paymentTransactions.createdAt, thisMonthStart))
        .groupBy(paymentTransactions.tenantId, tenants.name, tenants.cogsRate)
        .orderBy(desc(sql`SUM(amount) FILTER (WHERE ${paymentTransactions.status} = 'success')`))
        .limit(input.limit);

      // Last month GMV per tenant (for MoM growth)
      const lastMonth = await db
        .select({
          tenantId: paymentTransactions.tenantId,
          gmv: sql<string>`COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0)`,
        })
        .from(paymentTransactions)
        .where(
          and(
            gte(paymentTransactions.createdAt, lastMonthStart),
            sql`${paymentTransactions.createdAt} < ${thisMonthStart}`
          )
        )
        .groupBy(paymentTransactions.tenantId);

      const lastMonthMap = new Map(lastMonth.map((r) => [r.tenantId, parseFloat(r.gmv)]));

      return thisMonth.map((r) => {
        const gmvThis = parseFloat(r.gmv);
        const gmvLast = lastMonthMap.get(r.tenantId) ?? 0;
        const momGrowthPct = gmvLast > 0
          ? Math.round(((gmvThis - gmvLast) / gmvLast) * 1000) / 10
          : null;
        const cogsRate = r.cogsRate ?? 0.40;
        const netProfit = gmvThis * (1 - TXN_PROCESSING_COST_RATE - cogsRate);
        const platformRevenue = Math.round((netProfit * PLATFORM_REVENUE_SHARE + gmvThis * PLATFORM_TXN_SHARE) * 100) / 100;
        return {
          tenantId: r.tenantId,
          businessName: r.businessName ?? `Tenant ${r.tenantId.slice(0, 8)}`,
          gmvThisMonth: gmvThis,
          gmvLastMonth: gmvLast,
          momGrowthPct,
          txnCount: Number(r.txnCount),
          cogsRate,
          platformRevenue,
        };
      });
    }),

  // ── Forecast accuracy (snapshot history) ────────────────────────────────────
  getForecastAccuracy: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const { forecastSnapshots } = await import("../../drizzle/schema");
    const { desc: descOrd } = await import("drizzle-orm");
    const rows = await db.select().from(forecastSnapshots)
      .orderBy(descOrd(forecastSnapshots.createdAt))
      .limit(24);
    return rows.map((r) => ({
      id: r.id,
      snapshotMonth: r.snapshotMonth,
      projectedRevenue: parseFloat(r.projectedRevenue),
      projectedGmv: parseFloat(r.projectedGmv),
      actualRevenue: r.actualRevenue ? parseFloat(r.actualRevenue) : null,
      actualGmv: r.actualGmv ? parseFloat(r.actualGmv) : null,
      accuracyPct: r.accuracyPct ? parseFloat(r.accuracyPct) : null,
      resolvedAt: r.resolvedAt,
      createdAt: r.createdAt,
    }));
  }),

  // ── Revenue share config (read-only display) ────────────────────────────────
  getConfig: protectedProcedure.query(() => ({
    profitShareRate: PLATFORM_REVENUE_SHARE,
    txnShareRate: PLATFORM_TXN_SHARE,
    processingCostRate: TXN_PROCESSING_COST_RATE,
    cogsEstimateRate: 0.40,
    description:
      "Platform earns 5% of each tenant's estimated net profit (GMV minus processing fees and estimated COGS) plus 0.2% of all transaction volume.",
  })),
});
