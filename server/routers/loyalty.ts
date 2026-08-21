/**
 * server/routers/loyalty.ts — W27 loyalty points router.
 *
 * All buyer/merchant procedures are tenant-guarded; the earn sweep is
 * internalProcedure (server-to-server / cron). WhatsApp balance checks and
 * checkout redemption run inside the NLP pipeline (see routers/nlp.ts W27
 * block) which calls the service directly.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { internalProcedure, protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  awardPoints,
  getBalance,
  getLoyaltyRules,
  listLedger,
  previewRedemption,
  redeemPoints,
  sweepAwardPointsForDeliveredOrders,
  upsertLoyaltyRules,
} from "../services/loyalty";

export const loyaltyRouter = router({
  /** Tenant's earn/burn rules (defaults when unset). */
  getRules: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return getLoyaltyRules(db, input.tenantId);
    }),

  /** Merchant updates earn/burn rules. */
  setRules: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      enabled: z.boolean().optional(),
      pointsPerUnit: z.number().int().min(0).max(1000).optional(),
      unitValueCents: z.number().int().min(1).max(100_000_000).optional(),
      pointsValueCents: z.number().int().min(0).max(1_000_000).optional(),
      redemptionCapPercent: z.number().int().min(0).max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { tenantId, ...rules } = input;
      return upsertLoyaltyRules(db, tenantId, rules);
    }),

  /** Customer points balance. */
  balance: protectedProcedure
    .input(z.object({ tenantId: z.string(), customerPhone: z.string().min(7).max(30) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const balance = await getBalance(db, input.tenantId, input.customerPhone);
      const rules = await getLoyaltyRules(db, input.tenantId);
      return { balance, rules };
    }),

  /** Merchant manual adjustment (award). */
  award: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().min(7).max(30),
      points: z.number().int().min(1).max(1_000_000),
      reason: z.string().min(1).max(255),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return awardPoints(input, db);
    }),

  /** Merchant manual adjustment (clawback). */
  redeem: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().min(7).max(30),
      points: z.number().int().min(1).max(1_000_000),
      reason: z.string().min(1).max(255),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return redeemPoints(input, db);
    }),

  /** Preview the checkout redemption discount under the tenant's cap. */
  previewRedemption: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().min(7).max(30),
      orderTotalCents: z.number().int().min(0),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rules = await getLoyaltyRules(db, input.tenantId);
      const balance = await getBalance(db, input.tenantId, input.customerPhone);
      return previewRedemption(rules, balance, input.orderTotalCents);
    }),

  /** Ledger history (portal). */
  ledger: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().max(30).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return listLedger(db, input.tenantId, input);
    }),

  /** Server-to-server: award points for delivered orders without earn rows. */
  sweep: internalProcedure
    .input(z.object({ tenantId: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { scanned: 0, awarded: 0, points: 0 };
      return sweepAwardPointsForDeliveredOrders(db, input.tenantId);
    }),
});
