import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { quickReplyTemplates } from "../../drizzle/schema";
import { eq, and, or, ilike, desc, sql } from "drizzle-orm";
import { router, protectedProcedure } from "../_core/trpc";
import { z } from "zod";

export const quickReplyTemplatesRouter = router({
  /** List all templates, optionally filtered by category or search query. */
  list: protectedProcedure
    .input(z.object({
      category: z.string().optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { templates: [] };

      let query = db
        .select()
        .from(quickReplyTemplates)
        .orderBy(desc(quickReplyTemplates.usageCount), desc(quickReplyTemplates.createdAt))
        .limit(input.limit)
        .$dynamic();

      const conditions = [];
      if (input.category && input.category !== "all") {
        conditions.push(eq(quickReplyTemplates.category, input.category));
      }
      if (input.search && input.search.trim()) {
        const term = `%${input.search.trim()}%`;
        conditions.push(
          or(
            ilike(quickReplyTemplates.title, term),
            ilike(quickReplyTemplates.body, term)
          )
        );
      }
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      const templates = await query;
      return { templates };
    }),

  /** Create a new quick-reply template. */
  create: protectedProcedure
    .input(z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(4096),
      category: z.string().min(1).max(60).default("general"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [template] = await db
        .insert(quickReplyTemplates)
        .values({
          title: input.title.trim(),
          body: input.body.trim(),
          category: input.category.trim().toLowerCase(),
          createdBy: ctx.user.id,
        })
        .returning();

      return { template };
    }),

  /** Delete a template by ID. */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [deleted] = await db
        .delete(quickReplyTemplates)
        .where(eq(quickReplyTemplates.id, input.id))
        .returning({ id: quickReplyTemplates.id });

      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      }
      return { success: true };
    }),

  /** Increment usage count when a template is used. */
  incrementUsage: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { success: false };

      await db
        .update(quickReplyTemplates)
        .set({
          usageCount: sql`${quickReplyTemplates.usageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(quickReplyTemplates.id, input.id));

      return { success: true };
    }),

  /** List distinct categories that have at least one template. */
  listCategories: protectedProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) return { categories: [] };

      const rows = await db
        .selectDistinct({ category: quickReplyTemplates.category })
        .from(quickReplyTemplates)
        .orderBy(quickReplyTemplates.category);

      return { categories: rows.map((r) => r.category) };
    }),
});
