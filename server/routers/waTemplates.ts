/**
 * waTemplates router — tenant-admin management of Meta message templates.
 *
 * list        — cached templates (settings.waTemplates), optionally re-synced
 *               from Meta first; `approvedOnly` feeds the broadcast picker.
 * create      — submit a new UTILITY/MARKETING template to Meta for approval,
 *               then refresh the cache.
 * statusSync  — force a status re-sync (APPROVED/PENDING/REJECTED).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { assertTenantAccess, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import {
  approvedTemplates,
  createMetaTemplate,
  parseWaTemplateCache,
  syncWaTemplates,
  type WaTemplateCache,
} from "../services/waTemplates";

const tenantInput = z.object({ tenantId: z.string().min(1).max(36) });

async function loadCache(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tenantId: string): Promise<WaTemplateCache> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
  return parseWaTemplateCache(tenant.settings);
}

export const waTemplatesRouter = router({
  /**
   * Templates for the broadcast picker. Default view comes from the cache;
   * pass sync=true to refresh from Meta first. approvedOnly=true returns just
   * APPROVED templates (the only ones sendable outside the 24h window).
   */
  list: protectedProcedure
    .input(
      tenantInput.extend({
        approvedOnly: z.boolean().optional().default(false),
        sync: z.boolean().optional().default(false),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      let cache: WaTemplateCache;
      let syncError: string | null = null;
      if (input.sync) {
        try {
          cache = await syncWaTemplates(db, input.tenantId);
        } catch (err: any) {
          // Degrade to the cache — a failed sync must not blank the picker.
          syncError = String(err?.message ?? err).slice(0, 300);
          cache = await loadCache(db, input.tenantId);
        }
      } else {
        cache = await loadCache(db, input.tenantId);
      }
      const templates = input.approvedOnly ? approvedTemplates(cache) : cache.templates;
      return { templates, syncedAt: cache.syncedAt, syncError };
    }),

  /** Create + submit a template to Meta (UTILITY or MARKETING). */
  create: protectedProcedure
    .input(
      tenantInput.extend({
        name: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .regex(/^[a-z0-9_]+$/, "template name must be lowercase letters, digits and underscores"),
        category: z.enum(["UTILITY", "MARKETING"]),
        language: z.string().trim().min(2).max(10).default("en_US"),
        body: z.string().trim().min(1).max(1024),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      let created: { id: string; status: string };
      try {
        created = await createMetaTemplate(db, input.tenantId, {
          name: input.name,
          category: input.category,
          language: input.language,
          body: input.body,
        });
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err).slice(0, 300) });
      }
      // Best-effort cache refresh so the new template shows up immediately.
      const cache = await syncWaTemplates(db, input.tenantId).catch(() => null);
      return { ...created, syncedAt: cache?.syncedAt ?? null };
    }),

  /** Force a remote status re-sync into the cache. */
  statusSync: protectedProcedure
    .input(tenantInput)
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      try {
        const cache = await syncWaTemplates(db, input.tenantId);
        return { synced: true as const, count: cache.templates.length, syncedAt: cache.syncedAt };
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: String(err?.message ?? err).slice(0, 300) });
      }
    }),
});
