import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { marketplaceSellers, marketplaceCommissions } from "../../drizzle/schema";
import { randomUUID } from "crypto";

export const marketplaceRouter = router({
  // ── Seller Onboarding ────────────────────────────────────────────────────
  registerSeller: publicProcedure
    .input(z.object({
      tenantId: z.string(),
      businessName: z.string().min(2),
      ownerPhone: z.string(),
      ownerName: z.string().optional(),
      email: z.string().email().optional(),
      category: z.string().optional(),
      commissionRate: z.string().default("10.00"),
      bankAccountNumber: z.string().optional(),
      bankCode: z.string().optional(),
      bankName: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      await db.insert(marketplaceSellers).values({
        id, ...input, status: "pending", createdAt: now, updatedAt: now,
      });
      return { id, status: "pending" };
    }),

  listSellers: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = [eq(marketplaceSellers.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(marketplaceSellers.status, input.status as "pending" | "active" | "suspended" | "rejected"));
      return db.select().from(marketplaceSellers).where(and(...conds)).orderBy(desc(marketplaceSellers.createdAt)).limit(input.limit);
    }),

  getSeller: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const [seller] = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.id, input.id));
      return seller ?? null;
    }),

  updateSellerStatus: protectedProcedure
    .input(z.object({ id: z.string(), status: z.enum(["active", "suspended", "rejected"]) }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(marketplaceSellers).set({ status: input.status, updatedAt: new Date() }).where(eq(marketplaceSellers.id, input.id));
      return { ok: true };
    }),

  updateSellerCommission: protectedProcedure
    .input(z.object({ id: z.string(), commissionRate: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(marketplaceSellers).set({ commissionRate: input.commissionRate, updatedAt: new Date() }).where(eq(marketplaceSellers.id, input.id));
      return { ok: true };
    }),

  // ── Commission Engine ────────────────────────────────────────────────────
  recordCommission: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      sellerId: z.string(),
      orderId: z.string(),
      saleAmount: z.string(),
      commissionRate: z.string(),
      commissionAmount: z.string(),
      currency: z.string().default("NGN"),
    }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      const id = randomUUID();
      const now = new Date();
      const { tenantId: _t, ...commInput } = input;
      await db.insert(marketplaceCommissions).values({
        id, ...commInput, status: "pending", createdAt: now,
      });
      return { id };
    }),

  listCommissions: protectedProcedure
    .input(z.object({ tenantId: z.string().optional(), sellerId: z.string().optional(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds: ReturnType<typeof eq>[] = [];
      if (input.sellerId) conds.push(eq(marketplaceCommissions.sellerId, input.sellerId));
      if (input.status) conds.push(eq(marketplaceCommissions.status, input.status as "pending" | "paid" | "disputed" | "waived"));
      const query = db.select().from(marketplaceCommissions);
      if (conds.length > 0) return query.where(and(...conds)).orderBy(desc(marketplaceCommissions.createdAt)).limit(input.limit);
      return query.orderBy(desc(marketplaceCommissions.createdAt)).limit(input.limit);
    }),

  settleCommission: protectedProcedure
    .input(z.object({ id: z.string(), paidAt: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(marketplaceCommissions).set({ status: "paid", settledAt: new Date(input.paidAt ?? Date.now()) })
        .where(eq(marketplaceCommissions.id, input.id));
      return { ok: true };
    }),

  // ── Marketplace Stats ────────────────────────────────────────────────────
  marketplaceStats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const sellers = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.tenantId, input.tenantId));
      const commissions = await db.select().from(marketplaceCommissions);
      const totalCommission = commissions.reduce((sum, c) => sum + parseFloat(c.commissionAmount ?? "0"), 0);
      const paidCommission = commissions.filter(c => c.status === "paid").reduce((sum, c) => sum + parseFloat(c.commissionAmount ?? "0"), 0);
      return {
        totalSellers: sellers.length,
        activeSellers: sellers.filter(s => s.status === "active").length,
        pendingSellers: sellers.filter(s => s.status === "pending").length,
        totalCommissionEarned: totalCommission.toFixed(2),
        paidCommission: paidCommission.toFixed(2),
        pendingCommission: (totalCommission - paidCommission).toFixed(2),
      };
    }),
});
