// === W65 conversational ===
/**
 * server/routers/smartDefaults.ts — R10 smart defaults API.
 *
 *   smartDefaults.forContext   — predicted value for (tenant, user, context)
 *   smartDefaults.correct      — capture a correction learning event into
 *                                ui_events (action 'default_corrected')
 *
 * Tenant-scoped: tenantId is asserted against the caller; userId defaults to
 * the caller. Fail-open (defaults never block a form).
 */
import { z } from "zod";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDefaults, recordCorrection, SMART_DEFAULT_CONTEXTS } from "../services/smartDefaults";

const contextEnum = z.enum(SMART_DEFAULT_CONTEXTS);

export const smartDefaultsRouter = router({
  forContext: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        userId: z.string().max(64).optional(),
        context: contextEnum,
        category: z.string().max(120).optional(),
        productId: z.string().max(36).optional(),
        subjectId: z.string().max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return getDefaults({
        tenantId: input.tenantId,
        userId: input.userId ?? String(ctx.user.id),
        context: input.context,
        category: input.category ?? null,
        productId: input.productId ?? null,
        subjectId: input.subjectId ?? null,
      });
    }),

  correct: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().optional(),
        sessionId: z.string().max(64).optional(),
        app: z.string().max(32).optional(),
        context: contextEnum,
        suggested: z.unknown().optional(),
        actual: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.tenantId) assertTenantAccess(ctx.user, input.tenantId);
      return recordCorrection({
        tenantId: input.tenantId ?? ctx.user.tenantId ?? null,
        userId: String(ctx.user.id),
        sessionId: input.sessionId ?? null,
        app: input.app ?? null,
        context: input.context,
        suggested: input.suggested ?? null,
        actual: input.actual,
      });
    }),
});
