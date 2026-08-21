/**
 * W27 catalog-ai router — tenant-portal review/edit/publish of AI-drafted
 * listings (voice-note / photo → draft). All procedures are tenant-guarded.
 */
import { z } from "zod";
import { desc, eq, and } from "drizzle-orm";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { catalogAiDraftEvents, catalogAiDrafts } from "../../drizzle/schema";
import { editDraft, publishDraft, rejectDraft, suggestPriceCents } from "../services/catalogAI";

export const catalogAIRouter = router({
  /** List drafts (default: pending first, newest first). */
  listDrafts: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.enum(["pending_confirm", "confirmed", "rejected", "published", "expired"]).optional(),
      limit: z.number().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(catalogAiDrafts)
        .where(and(
          eq(catalogAiDrafts.tenantId, input.tenantId),
          ...(input.status ? [eq(catalogAiDrafts.status, input.status)] : []),
        ))
        .orderBy(desc(catalogAiDrafts.createdAt))
        .limit(input.limit);
    }),

  getDraft: protectedProcedure
    .input(z.object({ tenantId: z.string(), draftId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return null;
      const [draft] = await db.select().from(catalogAiDrafts)
        .where(and(eq(catalogAiDrafts.id, input.draftId), eq(catalogAiDrafts.tenantId, input.tenantId)))
        .limit(1);
      if (!draft) return null;
      const events = await db.select().from(catalogAiDraftEvents)
        .where(eq(catalogAiDraftEvents.draftId, input.draftId))
        .orderBy(desc(catalogAiDraftEvents.createdAt))
        .limit(50)
        .catch(() => []);
      return { ...draft, events };
    }),

  /** Edit fields of a pending draft before publishing. */
  updateDraft: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      draftId: z.string().uuid(),
      name: z.string().max(255).optional(),
      description: z.string().optional(),
      category: z.string().max(100).optional(),
      priceCents: z.number().int().min(0).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { ok: false as const, error: "db_unavailable" };
      const [draft] = await db.select({ tenantId: catalogAiDrafts.tenantId }).from(catalogAiDrafts)
        .where(eq(catalogAiDrafts.id, input.draftId)).limit(1);
      if (!draft || draft.tenantId !== input.tenantId) return { ok: false as const, error: "not_found" };
      return editDraft(db, input.draftId, String(ctx.user?.id ?? "portal"), {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
      });
    }),

  publishDraft: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      draftId: z.string().uuid(),
      name: z.string().max(255).optional(),
      description: z.string().optional(),
      category: z.string().max(100).optional(),
      priceCents: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { ok: false as const, error: "db_unavailable" };
      const [draft] = await db.select({ tenantId: catalogAiDrafts.tenantId }).from(catalogAiDrafts)
        .where(eq(catalogAiDrafts.id, input.draftId)).limit(1);
      if (!draft || draft.tenantId !== input.tenantId) return { ok: false as const, error: "not_found" };
      return publishDraft(db, input.draftId, String(ctx.user?.id ?? "portal"), {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
      });
    }),

  rejectDraft: protectedProcedure
    .input(z.object({ tenantId: z.string(), draftId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { ok: false as const, error: "db_unavailable" };
      const [draft] = await db.select({ tenantId: catalogAiDrafts.tenantId }).from(catalogAiDrafts)
        .where(eq(catalogAiDrafts.id, input.draftId)).limit(1);
      if (!draft || draft.tenantId !== input.tenantId) return { ok: false as const, error: "not_found" };
      return rejectDraft(db, input.draftId, String(ctx.user?.id ?? "portal"));
    }),

  /** Deterministic price suggestion for a category (integer cents). */
  suggestPrice: protectedProcedure
    .input(z.object({ tenantId: z.string(), category: z.string().max(100).optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return { suggestedPriceCents: null, bandLowCents: null, bandHighCents: null, basis: "none" as const, sampleSize: 0 };
      return suggestPriceCents(db, input.tenantId, input.category ?? null);
    }),
});
