import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  tenants, products, orders, conversations, customers,
  invoices, paymentTransactions, paymentGatewayConfigs,
  orderItems,
} from "../../drizzle/schema";
import { eq, and, desc, count, sum, gte, lte, sql } from "drizzle-orm";

// Guard: user must have a tenantId in their session (set during onboarding)
const tenantScopedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.tenantId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated with this account" });
  }
  return next({ ctx: { ...ctx, tenantId: ctx.user.tenantId } });
});

export const tenantPortalRouter = router({
  // ── My tenant info ────────────────────────────────────────────────────────
  getMyTenant: tenantScopedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
    return tenant;
  }),

  updateMyTenant: tenantScopedProcedure
    .input(z.object({
      name: z.string().min(2).optional(),
      defaultCurrency: z.string().length(3).optional(),
      defaultLanguage: z.string().optional(),
      aiEnabled: z.boolean().optional(),
      aiModel: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(tenants).set({ ...input, updatedAt: new Date() })
        .where(eq(tenants.id, ctx.tenantId));
      return { ok: true };
    }),

  // ── Dashboard KPIs ────────────────────────────────────────────────────────
  getDashboardKpis: tenantScopedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { orders: 0, revenue: 0, conversations: 0, customers: 0, pendingInvoices: 0 };

    const [orderStats] = await db.select({
      total: count(),
      revenue: sum(orders.totalAmount),
    }).from(orders).where(and(
      eq(orders.tenantId, ctx.tenantId),
      eq(orders.paymentStatus, "completed"),
    ));

    const [convStats] = await db.select({ total: count() }).from(conversations)
      .where(eq(conversations.tenantId, ctx.tenantId));

    const [custStats] = await db.select({ total: count() }).from(customers)
      .where(eq(customers.tenantId, ctx.tenantId));

    const [invStats] = await db.select({ total: count() }).from(invoices)
      .where(and(eq(invoices.tenantId, ctx.tenantId), eq(invoices.status, "sent")));

    return {
      orders: Number(orderStats?.total ?? 0),
      revenue: Number(orderStats?.revenue ?? 0),
      conversations: Number(convStats?.total ?? 0),
      customers: Number(custStats?.total ?? 0),
      pendingInvoices: Number(invStats?.total ?? 0),
    };
  }),

  // ── Products ──────────────────────────────────────────────────────────────
  listMyProducts: tenantScopedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(products)
        .where(eq(products.tenantId, ctx.tenantId))
        .orderBy(desc(products.createdAt))
        .limit(input.limit).offset(input.offset);
    }),

  updateMyProduct: tenantScopedProcedure
    .input(z.object({
      productId: z.string(),
      name: z.string().optional(),
      price: z.string().optional(),
      stockQuantity: z.number().optional(),
      status: z.enum(["active", "inactive", "archived"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { productId, ...fields } = input;
      // Verify product belongs to this tenant
      const [existing] = await db.select({ id: products.id })
        .from(products).where(and(eq(products.id, productId), eq(products.tenantId, ctx.tenantId)));
      if (!existing) throw new TRPCError({ code: "FORBIDDEN", message: "Product not found in your tenant" });
      await db.update(products).set({ ...fields, updatedAt: new Date() })
        .where(eq(products.id, productId));
      return { ok: true };
    }),

  // ── Orders ────────────────────────────────────────────────────────────────
  listMyOrders: tenantScopedProcedure
    .input(z.object({
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(orders.tenantId, ctx.tenantId)];
      if (input.status) conditions.push(eq(orders.status, input.status as any));
      return db.select().from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(input.limit).offset(input.offset);
    }),

  updateMyOrderStatus: tenantScopedProcedure
    .input(z.object({
      orderId: z.string(),
      status: z.enum(["confirmed", "processing", "shipped", "delivered", "cancelled"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [existing] = await db.select({ id: orders.id })
        .from(orders).where(and(eq(orders.id, input.orderId), eq(orders.tenantId, ctx.tenantId)));
      if (!existing) throw new TRPCError({ code: "FORBIDDEN", message: "Order not found in your tenant" });
      await db.update(orders).set({ status: input.status, updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));
      return { ok: true };
    }),

  // ── Invoices ──────────────────────────────────────────────────────────────
  listMyInvoices: tenantScopedProcedure
    .input(z.object({
      status: z.string().optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(invoices.tenantId, ctx.tenantId)];
      if (input.status) conditions.push(eq(invoices.status, input.status as any));
      return db.select().from(invoices)
        .where(and(...conditions))
        .orderBy(desc(invoices.createdAt))
        .limit(input.limit);
    }),

  // ── Payment gateway config (tenant manages their own) ─────────────────────
  getMyGatewayConfig: tenantScopedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(paymentGatewayConfigs)
      .where(eq(paymentGatewayConfigs.tenantId, ctx.tenantId));
    return rows.map(r => ({ ...r, secretKey: r.secretKey ? "••••••••" : null }));
  }),

  // ── Conversations ─────────────────────────────────────────────────────────
  listMyConversations: tenantScopedProcedure
    .input(z.object({
      status: z.string().optional(),
      limit: z.number().default(30),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(conversations.tenantId, ctx.tenantId)];
      if (input.status) conditions.push(eq(conversations.status, input.status as any));
      return db.select().from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.updatedAt))
        .limit(input.limit);
    }),

  // ── Recent payment transactions ───────────────────────────────────────────
  listMyTransactions: tenantScopedProcedure
    .input(z.object({ limit: z.number().default(20) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(paymentTransactions)
        .where(eq(paymentTransactions.tenantId, ctx.tenantId))
        .orderBy(desc(paymentTransactions.createdAt))
        .limit(input.limit);
    }),

  // ── Analytics ─────────────────────────────────────────────────────────────
  getAnalytics: tenantScopedProcedure
    .input(z.object({
      period: z.enum(["7d", "30d", "90d", "custom"]).default("30d"),
      startDate: z.string().optional(), // ISO date string
      endDate: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Compute date range
      const now = new Date();
      let start: Date;
      let end: Date = now;
      if (input.period === "custom" && input.startDate && input.endDate) {
        start = new Date(input.startDate);
        end = new Date(input.endDate);
        end.setHours(23, 59, 59, 999);
      } else {
        const days = input.period === "7d" ? 7 : input.period === "90d" ? 90 : 30;
        start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      }

      const tenantCond = eq(orders.tenantId, ctx.tenantId);
      const dateCond = and(gte(orders.createdAt, start), lte(orders.createdAt, end));

      // ── Summary stats ──────────────────────────────────────────────────────
      const [summary] = await db
        .select({
          totalOrders: count(),
          totalGmv: sum(orders.totalAmount),
        })
        .from(orders)
        .where(and(tenantCond, dateCond));

      const totalOrders = Number(summary?.totalOrders ?? 0);
      const totalGmv = parseFloat(String(summary?.totalGmv ?? "0"));
      const aov = totalOrders > 0 ? totalGmv / totalOrders : 0;

      // ── Daily GMV trend ────────────────────────────────────────────────────
      const dailyRows = await db
        .select({
          day: sql<string>`DATE("createdAt")`.as("day"),
          gmv: sum(orders.totalAmount),
          orderCount: count(),
        })
        .from(orders)
        .where(and(tenantCond, dateCond))
        .groupBy(sql`DATE("createdAt")`)
        .orderBy(sql`DATE("createdAt")`);

      // ── Top products by revenue ────────────────────────────────────────────
      // Join orderItems with orders to scope by tenant and date
      const topProducts = await db
        .select({
          productId: orderItems.productId,
          productName: orderItems.productName,
          totalRevenue: sql<string>`SUM(${orderItems.unitPrice} * ${orderItems.quantity})`.as("totalRevenue"),
          totalQuantity: sql<number>`SUM(${orderItems.quantity})`.as("totalQuantity"),
          orderCount: count(orderItems.orderId),
        })
        .from(orderItems)
        .innerJoin(orders, and(
          eq(orderItems.orderId, orders.id),
          eq(orders.tenantId, ctx.tenantId),
          gte(orders.createdAt, start),
          lte(orders.createdAt, end),
        ))
        .groupBy(orderItems.productId, orderItems.productName)
        .orderBy(sql`SUM(${orderItems.unitPrice} * ${orderItems.quantity}) DESC`)
        .limit(10);

      return {
        summary: {
          totalOrders,
          totalGmv,
          aov,
          periodDays: Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
        },
        dailyTrend: dailyRows.map(r => ({
          day: r.day,
          gmv: parseFloat(String(r.gmv ?? "0")),
          orderCount: Number(r.orderCount),
        })),
        topProducts: topProducts.map(p => ({
          productId: p.productId,
          productName: p.productName,
          totalRevenue: parseFloat(String(p.totalRevenue ?? "0")),
          totalQuantity: Number(p.totalQuantity ?? 0),
          orderCount: Number(p.orderCount),
        })),
      };
    }),
});
