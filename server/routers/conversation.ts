import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { channelMessages } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";

export const conversationRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      return db.getConversations(input.tenantId, input.status, input.limit, input.offset);
    }),

  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      return db.getConversationStats(input.tenantId);
    }),

  getMessages: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerPhone: z.string().optional(),
      limit: z.number().default(60),
    }))
    .query(async ({ input }) => {
      const dbConn = await getDb();
      if (!dbConn) return [];
      const rows = await dbConn
        .select()
        .from(channelMessages)
        .where(eq(channelMessages.tenantId, input.tenantId))
        .orderBy(desc(channelMessages.createdAt))
        .limit(input.limit);
      // Filter by phone if provided (match fromAddress or toAddress)
      if (input.customerPhone) {
        return rows.filter(r =>
          r.fromAddress === input.customerPhone || r.toAddress === input.customerPhone
        );
      }
      return rows;
    }),
});
