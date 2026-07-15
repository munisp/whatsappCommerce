import { z } from "zod";
import { desc, eq, gte, and, sql, count } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { waMessageDeliveryReceipts } from "../../drizzle/schema";

export const deliveryReceiptsRouter = router({
  // Called by the Meta webhook handler (public, validated by HMAC upstream)
  ingestStatusUpdate: publicProcedure
    .input(z.object({
      tenantId: z.string(),
      waMessageId: z.string(),
      recipientPhone: z.string().optional(),
      status: z.enum(["sent", "delivered", "read", "failed"]),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
      timestamp: z.number().optional(), // Unix seconds from Meta
      rawPayload: z.any().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { ok: false };
      const ts = input.timestamp ? new Date(input.timestamp * 1000) : new Date();
      await db.insert(waMessageDeliveryReceipts).values({
        tenantId: input.tenantId,
        waMessageId: input.waMessageId,
        recipientPhone: input.recipientPhone,
        status: input.status,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        timestamp: ts,
        rawPayload: input.rawPayload ?? null,
      });
      return { ok: true };
    }),

  // Returns delivery rate metrics for a tenant over a time window
  getMetrics: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      days: z.number().min(1).max(90).default(7),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { sent: 0, delivered: 0, read: 0, failed: 0, deliveryRate: 0, readRate: 0, failureRate: 0, recentMessages: [] };
      const cutoff = new Date(Date.now() - input.days * 86400 * 1000);

      // Aggregate counts by status
      const counts = await db
        .select({
          status: waMessageDeliveryReceipts.status,
          n: count(),
        })
        .from(waMessageDeliveryReceipts)
        .where(and(
          eq(waMessageDeliveryReceipts.tenantId, input.tenantId),
          gte(waMessageDeliveryReceipts.timestamp, cutoff),
        ))
        .groupBy(waMessageDeliveryReceipts.status);

      const byStatus: Record<string, number> = {};
      for (const row of counts) byStatus[row.status] = Number(row.n);

      const sent = byStatus["sent"] ?? 0;
      const delivered = byStatus["delivered"] ?? 0;
      const read = byStatus["read"] ?? 0;
      const failed = byStatus["failed"] ?? 0;
      const total = sent + delivered + read + failed;

      // Daily time series (last N days)
      const dailySeries = await db
        .select({
          day: sql<string>`DATE("timestamp")::text`,
          status: waMessageDeliveryReceipts.status,
          n: count(),
        })
        .from(waMessageDeliveryReceipts)
        .where(and(
          eq(waMessageDeliveryReceipts.tenantId, input.tenantId),
          gte(waMessageDeliveryReceipts.timestamp, cutoff),
        ))
        .groupBy(sql`DATE("timestamp")`, waMessageDeliveryReceipts.status)
        .orderBy(sql`DATE("timestamp")`);

      // Pivot daily series into { date, sent, delivered, read, failed }
      const dayMap: Record<string, Record<string, number>> = {};
      for (const row of dailySeries) {
        if (!dayMap[row.day]) dayMap[row.day] = { sent: 0, delivered: 0, read: 0, failed: 0 };
        dayMap[row.day][row.status] = Number(row.n);
      }
      const series = Object.entries(dayMap).map(([date, v]) => ({ date, ...v }));

      // Recent 20 messages with status
      const recentMessages = await db
        .select()
        .from(waMessageDeliveryReceipts)
        .where(eq(waMessageDeliveryReceipts.tenantId, input.tenantId))
        .orderBy(desc(waMessageDeliveryReceipts.timestamp))
        .limit(20);

      return {
        sent,
        delivered,
        read,
        failed,
        total,
        deliveryRate: total > 0 ? parseFloat(((delivered + read) / total * 100).toFixed(1)) : 0,
        readRate: total > 0 ? parseFloat((read / total * 100).toFixed(1)) : 0,
        failureRate: total > 0 ? parseFloat((failed / total * 100).toFixed(1)) : 0,
        series,
        recentMessages,
      };
    }),
});
