// === W65 conversational ===
/**
 * server/routers/commandBar.ts — R7 universal NL command bar API.
 *
 *   commandBar.parse    protected  — NL text → {intent, draftedParams,
 *                                    confirmToken, missingFields}
 *   commandBar.execute  protected  — consumes the one-shot confirmToken and
 *                                    runs the REAL existing mutation as the
 *                                    confirming user (admin intents re-gated
 *                                    by role inside the service).
 *   commandBar.intents  protected  — registry hint list for the UI palette.
 *
 * The confirm token is NOT a capability: execution rebuilds ctx from the
 * live session and the target procedure re-enforces tenant/role/KYB/step-up.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { executeCommand, listCommandIntents, parseCommand } from "../services/commandBar";

export const commandBarRouter = router({
  parse: protectedProcedure
    .input(z.object({ text: z.string().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      return parseCommand(input.text, ctx.user);
    }),

  execute: protectedProcedure
    .input(
      z.object({
        confirmToken: z.string().uuid(),
        /** Fields collected by the UI to fill the draft's missingFields. */
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await executeCommand(input.confirmToken, input.params, ctx as any);
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }),

  intents: protectedProcedure.query(() => listCommandIntents()),
});
