import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { finetuneRuns } from "../../drizzle/schema";
import { desc, eq } from "drizzle-orm";

export const fineTuneRouter = router({
  // List all fine-tune runs (newest first)
  listRuns: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }).optional())
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const rows = await db
        .select()
        .from(finetuneRuns)
        .orderBy(desc(finetuneRuns.startedAt))
        .limit(input?.limit ?? 20);
      return rows;
    }),

  // Get a single run by ID
  getRun: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const [run] = await db
        .select()
        .from(finetuneRuns)
        .where(eq(finetuneRuns.id, input.id))
        .limit(1);
      return run ?? null;
    }),
});
