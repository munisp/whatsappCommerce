/**
 * Invoice generation — subscription and profit-sharing billing models
 */
import { z } from "zod";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { invoices, orders, tenants } from "../../drizzle/schema";

export const invoiceRouter = router({
  /** Generate a monthly invoice for a tenant */
  generate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      type: z.enum(["subscription", "profit_share", "one_time"]),
      periodStart: z.string().datetime().optional(),
      periodEnd: z.string().datetime().optional(),
      subscriptionFee: z.number().optional(),
      commissionRate: z.number().min(0).max(1).optional(), // e.g. 0.05 = 5%
      currency: z.string().default("NGN"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const periodStart = input.periodStart ? new Date(input.periodStart) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const periodEnd = input.periodEnd ? new Date(input.periodEnd) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

      let subtotal = 0;
      let commissionAmount = 0;
      let subscriptionFee = input.subscriptionFee ?? 0;
      const lineItems: Array<{ description: string; amount: number; currency: string }> = [];

      if (input.type === "profit_share") {
        // Sum completed orders in period
        const result = await db.execute(sql`
          SELECT COALESCE(SUM(CAST("totalAmount" AS NUMERIC)), 0) AS revenue
          FROM orders
          WHERE "tenantId" = ${input.tenantId}
            AND "paymentStatus" = 'completed'
            AND "createdAt" >= ${periodStart}
            AND "createdAt" <= ${periodEnd}
        `);
        const revenue = Number((result as any[])[0]?.revenue ?? 0);
        subtotal = revenue;
        commissionAmount = revenue * (input.commissionRate ?? 0.05);
        lineItems.push({ description: `Revenue (${periodStart.toLocaleDateString()} – ${periodEnd.toLocaleDateString()})`, amount: revenue, currency: input.currency });
        lineItems.push({ description: `Platform commission (${((input.commissionRate ?? 0.05) * 100).toFixed(1)}%)`, amount: commissionAmount, currency: input.currency });
      } else if (input.type === "subscription") {
        subscriptionFee = input.subscriptionFee ?? 0;
        lineItems.push({ description: `Monthly subscription fee`, amount: subscriptionFee, currency: input.currency });
      } else {
        lineItems.push({ description: "One-time charge", amount: input.subscriptionFee ?? 0, currency: input.currency });
        subscriptionFee = input.subscriptionFee ?? 0;
      }

      const totalAmount = input.type === "profit_share" ? commissionAmount : subscriptionFee;
      const invoiceNumber = `INV-${input.tenantId.slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
      const dueDate = new Date(Date.now() + 14 * 86400000); // 14 days

      const [invoice] = await db.insert(invoices).values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        invoiceNumber,
        type: input.type,
        status: "draft",
        periodStart,
        periodEnd,
        subtotal: subtotal.toFixed(2),
        commissionRate: input.commissionRate?.toFixed(4),
        commissionAmount: commissionAmount.toFixed(2),
        subscriptionFee: subscriptionFee.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        currency: input.currency,
        lineItems,
        dueDate,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      return invoice;
    }),

  /** List invoices for a tenant */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["draft", "sent", "paid", "overdue", "cancelled"]).optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const conditions = [eq(invoices.tenantId, input.tenantId)];
      if (input.status) conditions.push(eq(invoices.status, input.status));
      return db.select().from(invoices)
        .where(and(...conditions))
        .orderBy(sql`${invoices.createdAt} DESC`)
        .limit(input.limit);
    }),

  /** Mark invoice as sent */
  send: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.update(invoices).set({
        status: "sent",
        sentAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(invoices.id, input.invoiceId));
      return { ok: true };
    }),

  /** Mark invoice as paid */
  markPaid: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await db.update(invoices).set({
        status: "paid",
        paidAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(invoices.id, input.invoiceId));
      return { ok: true };
    }),

  /** Get invoice details */
  get: protectedProcedure
    .input(z.object({ invoiceId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      return invoice;
    }),

  /** Summary stats */
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const result = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
          COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
          COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
          COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_count,
          COALESCE(SUM(CAST("totalAmount" AS NUMERIC)) FILTER (WHERE status = 'paid'), 0) AS total_collected,
          COALESCE(SUM(CAST("totalAmount" AS NUMERIC)) FILTER (WHERE status IN ('sent','overdue')), 0) AS total_outstanding
        FROM invoices WHERE "tenantId" = ${input.tenantId}
      `);
      return (result as any[])[0] ?? {};
    }),
});

