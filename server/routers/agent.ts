import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";

export const agentRouter = router({
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      return db.getAgentStats(input.tenantId);
    }),

  health: protectedProcedure.query(async () => {
    return db.getServiceHealth();
  }),
});

