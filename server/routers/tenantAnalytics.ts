import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { orders, customers, products, paymentTransactions } from "../../drizzle/schema";
import { eq, gte, sql, and, desc } from "drizzle-orm";

export const tenantAnalyticsRouter = router({
  // ── Overview: GMV, order count, revenue, avg order value ─────────────────
  getOverview: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      days: z.number().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { gmv: 0, orderCount: 0, revenue: 0, avgOrderValue: 0, paidOrders: 0, cancelledOrders: 0, newCustomers: 0 };
      const cutoff = new Date(Date.now() - input.days * 86400 * 1000);
      const prevCutoff = new Date(Date.now() - input.days * 2 * 86400 * 1000);

      // Current period
      const [cur] = await db.select({
        gmv: sql<number>`COALESCE(SUM(CAST(${orders.totalAmount} AS FLOAT)), 0)::float`,
        orderCount: sql<number>`COUNT(*)::int`,
        paidOrders: sql<number>`COUNT(CASE WHEN ${orders.paymentStatus} = 'paid' THEN 1 END)::int`,
        cancelledOrders: sql<number>`COUNT(CASE WHEN ${orders.status} = 'cancelled' THEN 1 END)::int`,
      }).from(orders).where(and(eq(orders.tenantId, input.tenantId), gte(orders.createdAt, cutoff)));

      // Previous period for comparison
      const [prev] = await db.select({
        gmv: sql<number>`COALESCE(SUM(CAST(${orders.totalAmount} AS FLOAT)), 0)::float`,
        orderCount: sql<number>`COUNT(*)::int`,
      }).from(orders).where(and(
        eq(orders.tenantId, input.tenantId),
        gte(orders.createdAt, prevCutoff),
        sql`${orders.createdAt} < ${cutoff}`
      ));

      // New customers in period
      const [newCust] = await db.select({
        count: sql<number>`COUNT(*)::int`,
      }).from(customers).where(and(eq(customers.tenantId, input.tenantId), gte(customers.createdAt, cutoff)));

      const gmv = cur?.gmv ?? 0;
      const orderCount = cur?.orderCount ?? 0;
      const avgOrderValue = orderCount > 0 ? gmv / orderCount : 0;
      const revenue = gmv * 0.05; // platform take-rate proxy
      const prevGmv = prev?.gmv ?? 0;
      const prevOrderCount = prev?.orderCount ?? 0;
      const gmvGrowth = prevGmv > 0 ? ((gmv - prevGmv) / prevGmv) * 100 : 0;
      const orderGrowth = prevOrderCount > 0 ? ((orderCount - prevOrderCount) / prevOrderCount) * 100 : 0;

      return {
        gmv: parseFloat(gmv.toFixed(2)),
        orderCount,
        revenue: parseFloat(revenue.toFixed(2)),
        avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
        paidOrders: cur?.paidOrders ?? 0,
        cancelledOrders: cur?.cancelledOrders ?? 0,
        newCustomers: newCust?.count ?? 0,
        gmvGrowth: parseFloat(gmvGrowth.toFixed(1)),
        orderGrowth: parseFloat(orderGrowth.toFixed(1)),
      };
    }),

  // ── Daily GMV time series ─────────────────────────────────────────────────
  getGmvTimeSeries: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      days: z.number().min(7).max(90).default(30),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { series: [] };
      const cutoff = new Date(Date.now() - input.days * 86400 * 1000);
      const rows = await db.select({
        date: sql<string>`DATE(${orders.createdAt})::text`,
        gmv: sql<number>`COALESCE(SUM(CAST(${orders.totalAmount} AS FLOAT)), 0)::float`,
        orderCount: sql<number>`COUNT(*)::int`,
      }).from(orders)
        .where(and(eq(orders.tenantId, input.tenantId), gte(orders.createdAt, cutoff)))
        .groupBy(sql`DATE(${orders.createdAt})`)
        .orderBy(sql`DATE(${orders.createdAt})`);
      return { series: rows.map(r => ({ date: r.date, gmv: parseFloat((r.gmv ?? 0).toFixed(2)), orders: r.orderCount ?? 0 })) };
    }),

  // ── Top products by revenue ───────────────────────────────────────────────
  getTopProducts: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      days: z.number().min(1).max(365).default(30),
      limit: z.number().min(1).max(20).default(10),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { products: [] };
      const cutoff = new Date(Date.now() - input.days * 86400 * 1000);
      // Extract product names and amounts from the JSONB items array
      const rows = await db.execute(sql`
        SELECT
          item->>'name' AS product_name,
          item->>'productId' AS product_id,
          COUNT(*)::int AS order_count,
          COALESCE(SUM(CAST(item->>'quantity' AS FLOAT) * CAST(item->>'price' AS FLOAT)), 0)::float AS revenue
        FROM orders o,
             jsonb_array_elements(o.items) AS item
        WHERE o."tenantId" = ${input.tenantId}
          AND o."createdAt" >= ${cutoff}
          AND o.status != 'cancelled'
          AND item->>'name' IS NOT NULL
        GROUP BY item->>'name', item->>'productId'
        ORDER BY revenue DESC
        LIMIT ${input.limit}
      `);
      return {
        products: (rows as any[]).map(r => ({
          name: r.product_name ?? "Unknown",
          productId: r.product_id,
          orderCount: r.order_count ?? 0,
          revenue: parseFloat((r.revenue ?? 0).toFixed(2)),
        })),
      };
    }),

  // ── Customer retention: repeat vs new ────────────────────────────────────
  getRetention: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      days: z.number().min(7).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { newCustomers: 0, returningCustomers: 0, retentionRate: 0, cohorts: [] };
      const cutoff = new Date(Date.now() - input.days * 86400 * 1000);
      // Customers with orders in the period
      const periodCustomers = await db.execute(sql`
        SELECT
          o."customerId",
          COUNT(*)::int AS order_count,
          MIN(o."createdAt") AS first_order_in_period
        FROM orders o
        WHERE o."tenantId" = ${input.tenantId}
          AND o."createdAt" >= ${cutoff}
          AND o.status != 'cancelled'
        GROUP BY o."customerId"
      `);
      // Customers who had orders BEFORE the period (returning)
      const returningSet = await db.execute(sql`
        SELECT DISTINCT o."customerId"
        FROM orders o
        WHERE o."tenantId" = ${input.tenantId}
          AND o."createdAt" < ${cutoff}
          AND o.status != 'cancelled'
      `);
      const returningIds = new Set((returningSet as any[]).map(r => r.customerId));
      const periodIds = (periodCustomers as any[]).map(r => r.customerId);
      const returning = periodIds.filter(id => returningIds.has(id)).length;
      const newCount = periodIds.length - returning;
      const retentionRate = periodIds.length > 0 ? (returning / periodIds.length) * 100 : 0;

      // Weekly cohort breakdown
      const cohorts = await db.execute(sql`
        SELECT
          DATE_TRUNC('week', o."createdAt")::date::text AS week,
          COUNT(DISTINCT o."customerId")::int AS customers,
          COUNT(*)::int AS orders
        FROM orders o
        WHERE o."tenantId" = ${input.tenantId}
          AND o."createdAt" >= ${cutoff}
          AND o.status != 'cancelled'
        GROUP BY DATE_TRUNC('week', o."createdAt")
        ORDER BY week
      `);

      return {
        newCustomers: newCount,
        returningCustomers: returning,
        retentionRate: parseFloat(retentionRate.toFixed(1)),
        cohorts: (cohorts as any[]).map(c => ({ week: c.week, customers: c.customers ?? 0, orders: c.orders ?? 0 })),
      };
    }),

  // ── Payment method breakdown ──────────────────────────────────────────────
  getPaymentBreakdown: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      days: z.number().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { breakdown: [] };
      const cutoff = new Date(Date.now() - input.days * 86400 * 1000);
      const rows = await db.select({
        provider: paymentTransactions.provider,
        count: sql<number>`COUNT(*)::int`,
        total: sql<number>`COALESCE(SUM(CAST(${paymentTransactions.amount} AS FLOAT)), 0)::float`,
      }).from(paymentTransactions)
        .where(and(
          eq(paymentTransactions.tenantId, input.tenantId),
          gte(paymentTransactions.createdAt, cutoff),
          eq(paymentTransactions.status, "completed")
        ))
        .groupBy(paymentTransactions.provider)
        .orderBy(desc(sql`COUNT(*)`));
      return {
        breakdown: rows.map((r: { provider: string | null; count: number; total: number }) => ({
          provider: r.provider ?? "unknown",
          count: r.count ?? 0,
          total: parseFloat((r.total ?? 0).toFixed(2)),
        })),
      };
    }),
});
