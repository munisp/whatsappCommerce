import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";

export const orderRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      return db.getOrders(input.tenantId, input.status, input.limit, input.offset);
    }),

  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      return db.getOrderStats(input.tenantId);
    }),
});

