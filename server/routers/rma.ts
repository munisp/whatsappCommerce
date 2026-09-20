/**
 * rma router — W41 (Coder C) merchant-side returns management (ORD-6/UC-4)
 * plus tenant multi-currency DISPLAY config (UC-5).
 *
 * Lifecycle lives in services/rma.ts; this router is the admin/operator
 * surface (approve/reject, mark received+restock, refund psp|wallet, list).
 * The buyer-facing chat path ("return order X") is in routers/nlp.ts.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import { getDb } from "../db";
import { rmaRequests, tenants } from "../../drizzle/schema";
import { decideReturn, receiveAndRestock, refundReturn, requestReturn } from "../services/rma";

export const rmaRouter = router({
  /** List RMAs for a tenant (optionally by status/order). */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["requested", "approved", "rejected", "received", "restocked", "refunded", "closed"]).optional(),
      orderId: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const conds = [eq(rmaRequests.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(rmaRequests.status, input.status));
      if (input.orderId) conds.push(eq(rmaRequests.orderId, input.orderId));
      return db.select().from(rmaRequests)
        .where(and(...conds))
        .orderBy(desc(rmaRequests.createdAt))
        .limit(input.limit);
    }),

  /** Merchant-initiated return (e.g. from the admin order page). */
  create: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string(),
      buyerRef: z.string().min(1),
      reason: z.string().min(1),
      items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1) })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return requestReturn(db, { ...input, requestedVia: "admin" });
    }),

  /** Approve or reject a pending request. */
  decide: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      rmaId: z.string(),
      approve: z.boolean(),
      note: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return decideReturn(db, input);
    }),

  /** Goods received → restock via the W38 unified helpers. */
  receive: protectedProcedure
    .input(z.object({ tenantId: z.string(), rmaId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return receiveAndRestock(db, input);
    }),

  /** Refund via the W38 refund path (psp) or a customer-wallet credit. */
  refund: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      rmaId: z.string(),
      method: z.enum(["psp", "wallet"]),
      amountCents: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Refunds real money (psp or wallet) — finance-gated, not any tenant staffer.
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return refundReturn(db, input);
    }),

  // ── UC-5: tenant multi-currency DISPLAY config (manual rates) ────────────

  /** Read the tenant's display-currency config. */
  getDisplayFx: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [tenant] = await db
        .select({ displayCurrency: tenants.displayCurrency, displayFxRates: tenants.displayFxRates })
        .from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      return tenant ?? null;
    }),

  /**
   * Set/clear the display currency + manual rate (display-currency units per
   * 1 NGN). Display-only: charges remain NGN (see services/displayFx.ts).
   */
  setDisplayFx: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      displayCurrency: z.string().length(3).nullable(),
      /** display-currency units per 1 NGN, e.g. 0.00066 for USD. */
      rate: z.number().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const currency = input.displayCurrency?.toUpperCase() ?? null;
      const rates = currency && input.rate
        ? { [currency]: { rate: String(input.rate), updatedAt: new Date().toISOString() } }
        : null;
      if (currency && !rates) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "rate is required when setting a display currency" });
      }
      await db.update(tenants).set({
        displayCurrency: currency,
        displayFxRates: rates,
        updatedAt: new Date(),
      }).where(eq(tenants.id, input.tenantId));
      return { displayCurrency: currency, displayFxRates: rates };
    }),
});
