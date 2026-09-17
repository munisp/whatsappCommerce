/**
 * === W41 Coder A (UC-1/UC-6) ===
 * buyerCredit router — merchant opt-in + threshold config for buyer
 * installments, and read views over plans. Tenant-scoped like orderCrud.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  getBuyerInstallmentConfig,
  setBuyerInstallmentConfig,
  listBuyerPlans,
  getBuyerPlanForOrder,
  getFulfillmentGatingPlan,
} from "../services/buyerInstallments";

export const buyerCreditRouter = router({
  /** Merchant opt-in state + threshold (fail-closed default: disabled). */
  getInstallmentConfig: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return getBuyerInstallmentConfig(db, input.tenantId);
    }),

  /** Enable/disable buyer installments + order-total threshold (integer cents). */
  setInstallmentConfig: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      enabled: z.boolean(),
      minTotalCents: z.number().int().min(0).optional(),
      choices: z.array(z.number().int()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      try {
        return await setBuyerInstallmentConfig(db, input.tenantId, {
          enabled: input.enabled,
          minTotalCents: input.minTotalCents,
          choices: input.choices,
        });
      } catch (e: any) {
        if (e?.code === "BAD_REQUEST") throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        if (e?.code === "NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message: e.message });
        throw e;
      }
    }),

  /** All buyer installment plans for the tenant (merchant dashboard). */
  listPlans: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return listBuyerPlans(db, input.tenantId);
    }),

  /** The installment plan (if any) attached to one order + fulfillment gate. */
  planForOrder: protectedProcedure
    .input(z.object({ tenantId: z.string(), orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const plan = await getBuyerPlanForOrder(db, input.tenantId, input.orderId);
      const gating = await getFulfillmentGatingPlan(db, input.orderId);
      return { plan, fulfillmentGated: gating != null };
    }),
});
