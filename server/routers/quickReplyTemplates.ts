import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { quickReplyTemplates } from "../../drizzle/schema";
import { eq, and, or, ilike, desc, sql } from "drizzle-orm";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { z } from "zod";

/**
 * Tenant-scoped, like tenantPortal.* — the caller's own tenantId, never a
 * client-supplied one. Rows created before this scoping existed have a null
 * tenantId; those are legacy/orphaned and only a platform admin may touch
 * them (see delete/incrementUsage).
 */
export const quickReplyTemplatesRouter = router({
  /** List the caller's own tenant's templates, optionally filtered. */
  list: protectedProcedure
    .input(z.object({
      category: z.string().optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db || !ctx.user.tenantId) return { templates: [] };

      let query = db
        .select()
        .from(quickReplyTemplates)
        .orderBy(desc(quickReplyTemplates.usageCount), desc(quickReplyTemplates.createdAt))
        .limit(input.limit)
        .$dynamic();

      const conditions = [eq(quickReplyTemplates.tenantId, ctx.user.tenantId)];
      if (input.category && input.category !== "all") {
        conditions.push(eq(quickReplyTemplates.category, input.category));
      }
      if (input.search && input.search.trim()) {
        const term = `%${input.search.trim()}%`;
        conditions.push(
          or(
            ilike(quickReplyTemplates.title, term),
            ilike(quickReplyTemplates.body, term)
          )!
        );
      }
      query = query.where(and(...conditions));

      const templates = await query;
      return { templates };
    }),

  /** Create a new quick-reply template, owned by the caller's own tenant. */
  create: protectedProcedure
    .input(z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(4096),
      category: z.string().min(1).max(60).default("general"),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only tenant staff can save quick-reply templates" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [template] = await db
        .insert(quickReplyTemplates)
        .values({
          tenantId: ctx.user.tenantId,
          title: input.title.trim(),
          body: input.body.trim(),
          category: input.category.trim().toLowerCase(),
          createdBy: ctx.user.id,
        })
        .returning();

      return { template };
    }),

  /** Delete a template by ID — only the owning tenant (or an admin, for legacy untenanted rows). */
  delete: protectedProcedure
    // authz:exempt shared quick-reply template library (tenantId nullable; list is global), cross-tenant by design
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [existing] = await db
        .select({ id: quickReplyTemplates.id, tenantId: quickReplyTemplates.tenantId })
        .from(quickReplyTemplates)
        .where(eq(quickReplyTemplates.id, input.id))
        .limit(1);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      }
      if (existing.tenantId) {
        assertTenantAccess(ctx.user, existing.tenantId);
      } else if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to delete this template" });
      }

      const [deleted] = await db
        .delete(quickReplyTemplates)
        .where(eq(quickReplyTemplates.id, input.id))
        .returning({ id: quickReplyTemplates.id });

      return { success: !!deleted };
    }),

  /** Increment usage count when a template is used. */
  incrementUsage: protectedProcedure
    // authz:exempt shared quick-reply template library (tenantId nullable; list is global), cross-tenant by design
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { success: false };

      const [existing] = await db
        .select({ id: quickReplyTemplates.id, tenantId: quickReplyTemplates.tenantId })
        .from(quickReplyTemplates)
        .where(eq(quickReplyTemplates.id, input.id))
        .limit(1);
      if (!existing) return { success: false };
      if (existing.tenantId) {
        assertTenantAccess(ctx.user, existing.tenantId);
      } else if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to use this template" });
      }

      await db
        .update(quickReplyTemplates)
        .set({
          usageCount: sql`${quickReplyTemplates.usageCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(quickReplyTemplates.id, input.id));

      return { success: true };
    }),

  /** List distinct categories that have at least one of the caller's own tenant's templates. */
  listCategories: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db || !ctx.user.tenantId) return { categories: [] };

      const rows = await db
        .selectDistinct({ category: quickReplyTemplates.category })
        .from(quickReplyTemplates)
        .where(eq(quickReplyTemplates.tenantId, ctx.user.tenantId))
        .orderBy(quickReplyTemplates.category);

      return { categories: rows.map((r) => r.category) };
    }),
});
