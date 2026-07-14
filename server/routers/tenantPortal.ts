import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  tenants, products, orders, conversations, customers,
  invoices, paymentTransactions, paymentGatewayConfigs,
} from "../../drizzle/schema";
import { eq, and, desc, count, sum, gte } from "drizzle-orm";

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
});

