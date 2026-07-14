import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";

export const paymentRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      return db.getPaymentIntents(input.tenantId, input.status, input.limit, input.offset);
    }),
});

