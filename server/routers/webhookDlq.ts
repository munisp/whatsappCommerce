import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { waWebhookEvents } from "../../drizzle/schema";
import { desc, eq, inArray, or, and, lte } from "drizzle-orm";
import { z } from "zod";

export const webhookDlqRouter = router({
  listEvents: protectedProcedure
    .input(z.object({
      status: z.enum(["received", "processed", "failed", "retried", "dead", "all"]).default("all"),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds = input.status !== "all"
        ? [eq(waWebhookEvents.status, input.status)]
        : [];
      return db.select().from(waWebhookEvents)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(waWebhookEvents.createdAt))
        .limit(input.limit);
    }),

  retryEvent: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      // Reset to received so the retry heartbeat picks it up immediately
      await db.update(waWebhookEvents)
        .set({ status: "received", nextRetryAt: new Date(), retryCount: 0, lastError: null, updatedAt: new Date() })
        .where(eq(waWebhookEvents.id, input.id));
      return { ok: true };
    }),

  dismissEvent: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(waWebhookEvents)
        .set({ status: "dead", updatedAt: new Date() })
        .where(eq(waWebhookEvents.id, input.id));
      return { ok: true };
    }),

  stats: protectedProcedure.query(async () => {
    const db = (await getDb())!;
    const all = await db.select({ status: waWebhookEvents.status }).from(waWebhookEvents);
    const counts = { received: 0, processed: 0, failed: 0, retried: 0, dead: 0 };
    for (const row of all) {
      if (row.status in counts) counts[row.status as keyof typeof counts]++;
    }
    return counts;
  }),
});
