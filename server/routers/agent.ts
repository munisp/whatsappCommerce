import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { agentEvents } from "../../drizzle/schema";
import { eq, desc, and, gte, lte } from "drizzle-orm";

export const agentRouter = router({
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      return db.getAgentStats(input.tenantId);
    }),

  health: protectedProcedure.query(async () => {
    return db.getServiceHealth();
  }),
  listAuditLog: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      eventType: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      const dbInst = await getDb();
      if (!dbInst) return { events: [], total: 0 };
      const conditions: any[] = [];
      if (input.tenantId) conditions.push(eq(agentEvents.tenantId, input.tenantId));
      if (input.eventType) conditions.push(eq(agentEvents.eventType, input.eventType as any));
      if (input.startDate) conditions.push(gte(agentEvents.createdAt, new Date(input.startDate)));
      if (input.endDate) {
        const end = new Date(input.endDate);
        end.setHours(23, 59, 59, 999);
        conditions.push(lte(agentEvents.createdAt, end));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const events = await dbInst.select().from(agentEvents)
        .where(where)
        .orderBy(desc(agentEvents.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return { events, total: events.length };
    }),
});
