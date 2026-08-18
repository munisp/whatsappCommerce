/**
 * server/routers/copilot.ts — W22 LLM copilot router.
 *
 * Tenant-guarded surface over server/services/llmCopilot.ts:
 *   triageIncident (mutation) — structured SOC2 incident triage suggestion
 *   ask            (mutation) — merchant Q&A over tenant-scoped aggregates
 *   history        (query)    — copilot_queries audit log (hashes only)
 *
 * The service NEVER throws; LLM provider faults degrade to deterministic
 * fallbacks (fallbackUsed=true). Guards: every procedure requires
 * tenantId input and calls assertTenantAccess.
 */
import { z } from "zod";
import { desc, eq, and } from "drizzle-orm";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { copilotQueries } from "../../drizzle/schema";
import { merchantAsk, triageIncident, COPILOT_PARAMS } from "../services/llmCopilot";

const kindEnum = z.enum(["triage", "ask"]);

export const copilotRouter = router({
  triageIncident: protectedProcedure
    .input(z.object({ tenantId: z.string(), incidentId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return triageIncident(input.tenantId, input.incidentId);
    }),

  ask: protectedProcedure
    .input(z.object({ tenantId: z.string(), question: z.string().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return merchantAsk(input.tenantId, input.question);
    }),

  history: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        kind: kindEnum.optional(),
        limit: z.number().int().min(1).max(200).default(COPILOT_PARAMS.historyLimit),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(copilotQueries.tenantId, input.tenantId)];
      if (input.kind) conds.push(eq(copilotQueries.kind, input.kind));
      return db
        .select()
        .from(copilotQueries)
        .where(and(...conds))
        .orderBy(desc(copilotQueries.createdAt))
        .limit(input.limit);
    }),
});
