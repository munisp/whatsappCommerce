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
