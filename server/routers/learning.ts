// === W66 learning ===
/**
 * server/routers/learning.ts — R6/R8 learning-loop APIs.
 *
 *   learning.intentMisses        admin  — pending intent-miss review queue
 *   learning.reviewIntentMiss    admin  — approve (→ few-shot append) / reject
 *   learning.demandSummary       tenant — zero-result demand signals (7d)
 *   learning.restockSignals      tenant — depletion / days-of-cover signals
 *   learning.restockDrafts       tenant — auto-drafted restock POs
 *   learning.confirmRestockDraft tenant — claim-first draft→submitted confirm
 *
 * The hermes procurement copilot reuses the W65 command bar
 * (commandBar.parse/execute with the restock_po intent) — no parallel draft
 * machinery here.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";

export const learningRouter = router({
  intentMisses: adminProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      status: z.enum(["pending", "approved", "rejected"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "db unavailable" });
      const { listIntentMisses } = await import("../services/intentMisses");
      return listIntentMisses(db, input);
    }),

  reviewIntentMiss: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      decision: z.enum(["approved", "rejected"]),
      correctedIntent: z.string().max(64).optional(),
      reviewerNotes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "db unavailable" });
      const { reviewIntentMiss } = await import("../services/intentMisses");
      const res = await reviewIntentMiss(db, {
        ...input,
        reviewedBy: ctx.user.email ?? ctx.user.name ?? String(ctx.user.id),
      });
      if (!res.ok) {
        const code = res.reason === "not_found" ? "NOT_FOUND"
          : res.reason === "already_reviewed" ? "CONFLICT" : "BAD_REQUEST";
        throw new TRPCError({ code, message: res.reason });
      }
      return res.miss;
    }),

  demandSummary: protectedProcedure
    .input(z.object({ tenantId: z.string(), days: z.number().int().min(1).max(90).optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const { summarizeDemandSignals } = await import("../services/demandSignals");
      return summarizeDemandSignals(db, input.tenantId, { days: input.days });
    }),

  restockSignals: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const { computeRestockSignals, lowCoverSignals } = await import("../services/restockIntel");
      return lowCoverSignals(await computeRestockSignals(db, input.tenantId));
    }),

  restockDrafts: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const { listRestockDrafts } = await import("../services/restockIntel");
      return listRestockDrafts(db, input.tenantId);
    }),

  confirmRestockDraft: protectedProcedure
    .input(z.object({ tenantId: z.string(), poId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "db unavailable" });
      const { confirmRestockDraft } = await import("../services/restockIntel");
      const res = await confirmRestockDraft(db, input);
      if (!res.ok) {
        throw new TRPCError({
          code: res.reason === "not_found" ? "NOT_FOUND" : "CONFLICT",
          message: res.reason === "not_found" ? "Draft PO not found" : "Draft was already confirmed or is no longer a draft",
        });
      }
      return res;
    }),
});
// === END W66 learning ===
