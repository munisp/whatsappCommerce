import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import * as db from "../db";

export const orderRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return db.getOrders(input.tenantId, input.status, input.limit, input.offset);
    }),

  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return db.getOrderStats(input.tenantId);
    }),

  // Found live 2026-09-26, aggressive dashboard QA sweep: several orders sit in "pending"/unpaid forever
  // (mostly artifacts of the now-fixed currency/location bug) with no way for a tenant to close them out.
  // Scoped to unpaid orders only — see the doc comment on db.cancelOrder for why.
  cancel: protectedProcedure
    .input(z.object({ tenantId: z.string(), orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return db.cancelOrder(input.tenantId, input.orderId);
    }),
});

