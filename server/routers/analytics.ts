import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";

const adminProcedure = protectedProcedure;

export const analyticsRouter = router({
  platformOverview: adminProcedure.query(async () => {
    return db.getPlatformOverview();
  }),

  tenantDashboard: adminProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const [convStats, orderStats, productStats, agentStats, customerCount] = await Promise.all([
        db.getConversationStats(input.tenantId),
        db.getOrderStats(input.tenantId),
        db.getProductStats(input.tenantId),
        db.getAgentStats(input.tenantId),
        db.getCustomerCount(input.tenantId),
      ]);
      return { conversations: convStats, orders: orderStats, products: productStats, agent: agentStats, customers: customerCount };
    }),
});

