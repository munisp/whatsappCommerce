/**
 * server/routers/orchestrator.ts — W23 journey orchestration tRPC router.
 *
 * Tenant-guarded access to the Temporal journey orchestrator
 * (services/journeyOrchestrator.ts):
 *   - orchestrator.start   — start a registered journey orchestration
 *   - orchestrator.status  — status + checkpoint count for a run
 *   - orchestrator.history — full checkpoint history for a run
 * Cross-tenant access to a run is FORBIDDEN (runs carry tenantId).
 */
import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { TRPCError } from "@trpc/server";

export const orchestratorRouter = router({
  start: protectedProcedure
    .input(z.object({
      journeyId: z.string().min(1).max(128),
      tenantId: z.string().min(1).max(36),
      params: z.record(z.string(), z.unknown()).default({}),
      deferExecution: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const { startJourneyOrchestration } = await import("../services/journeyOrchestrator");
      return startJourneyOrchestration(input.journeyId, input.params, {
        tenantId: input.tenantId,
        deferExecution: input.deferExecution,
      });
    }),

  status: protectedProcedure
    .input(z.object({ runId: z.string().min(1).max(128) }))
    .query(async ({ input, ctx }) => {
      const { getOrchestrationStatus } = await import("../services/journeyOrchestrator");
      const status = await getOrchestrationStatus(input.runId);
      // A2-06: orchestration runs are tenant-confidential.
      if (status.tenantId) assertTenantAccess(ctx.user, status.tenantId);
      else if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only access your own tenant's data" });
      }
      return status;
    }),

  history: protectedProcedure
    .input(z.object({ runId: z.string().min(1).max(128) }))
    .query(async ({ input, ctx }) => {
      const { getOrchestrationHistory } = await import("../services/journeyOrchestrator");
      const history = await getOrchestrationHistory(input.runId);
      if (history.tenantId) assertTenantAccess(ctx.user, history.tenantId);
      else if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only access your own tenant's data" });
      }
      return history;
    }),
});
