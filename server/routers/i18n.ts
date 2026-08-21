/**
 * W27 i18n router — tenant + customer locale preference procedures and
 * per-tenant message overrides.
 *
 * Tenant surface (`tenant.*`): session-tenant scoped (ctx.user.tenantId) —
 * same pattern as geo.merchant. The tenant default locale is persisted to
 * tenants.settings.locale (the same key resolveLocale already consults).
 *
 * Customer surface: customer locale is set durably via the WhatsApp
 * language-selection flow (server/services/i18n.ts setStickyLocale →
 * customers.language). `setCustomerLocale` is exposed as an internalProcedure
 * for server-to-server callers (inbound pipeline / USSD gateway).
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { internalProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenantI18nOverrides, tenants } from "../../drizzle/schema";
import {
  isLocale,
  LOCALE_NAMES,
  setStickyLocale,
  SUPPORTED_LOCALES,
  MESSAGE_CATALOG,
  type MessageKey,
} from "../services/i18n";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const localeSchema = z
  .string()
  .max(8)
  .refine((v) => isLocale(v), { message: `locale must be one of ${SUPPORTED_LOCALES.join(", ")}` });

export const i18nRouter = router({
  /** Public-ish metadata for pickers: supported locales + display names. */
  listLocales: protectedProcedure.query(() => ({
    locales: SUPPORTED_LOCALES.map((l) => ({ code: l, name: LOCALE_NAMES[l] })),
  })),

  /** Read the tenant's current default locale (settings.locale, default en). */
  getTenantLocale: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId;
    if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
    const db = await requireDb();
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const current = (tenant?.settings as any)?.locale;
    return { locale: isLocale(current) ? current : "en" };
  }),

  /** Set the tenant default locale (used when no per-customer preference exists). */
  setTenantLocale: protectedProcedure
    .input(z.object({ locale: localeSchema }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
      const db = await requireDb();
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const settings = { ...((tenant?.settings as Record<string, unknown>) ?? {}), locale: input.locale };
      await db.update(tenants).set({ settings, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
      return { locale: input.locale };
    }),

  /** List the tenant's message overrides (optionally filtered by locale). */
  listOverrides: protectedProcedure
    .input(z.object({ locale: localeSchema.optional() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
      const db = await requireDb();
      const where = input.locale
        ? and(eq(tenantI18nOverrides.tenantId, tenantId), eq(tenantI18nOverrides.locale, input.locale))
        : eq(tenantI18nOverrides.tenantId, tenantId);
      return db.select().from(tenantI18nOverrides).where(where).limit(500);
    }),

  /** Upsert a per-tenant translation override for a catalog key. */
  setOverride: protectedProcedure
    .input(z.object({
      locale: localeSchema,
      key: z.string().max(64).refine((k) => k in MESSAGE_CATALOG.en, { message: "unknown catalog key" }),
      text: z.string().min(1).max(1000),
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
      const db = await requireDb();
      const [existing] = await db
        .select({ id: tenantI18nOverrides.id })
        .from(tenantI18nOverrides)
        .where(and(
          eq(tenantI18nOverrides.tenantId, tenantId),
          eq(tenantI18nOverrides.locale, input.locale),
          eq(tenantI18nOverrides.key, input.key),
        ))
        .limit(1);
      if (existing) {
        await db.update(tenantI18nOverrides)
          .set({ text: input.text, updatedAt: new Date() })
          .where(eq(tenantI18nOverrides.id, existing.id));
        return { id: existing.id, updated: true };
      }
      const [row] = await db.insert(tenantI18nOverrides).values({
        tenantId, locale: input.locale, key: input.key as MessageKey, text: input.text,
      }).returning();
      return { id: row.id, updated: false };
    }),

  /** Remove an override (locale pack fallback resumes). */
  removeOverride: protectedProcedure
    .input(z.object({ locale: localeSchema, key: z.string().max(64) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
      const db = await requireDb();
      await db.delete(tenantI18nOverrides).where(and(
        eq(tenantI18nOverrides.tenantId, tenantId),
        eq(tenantI18nOverrides.locale, input.locale),
        eq(tenantI18nOverrides.key, input.key),
      ));
      return { removed: true };
    }),

  /**
   * Server-to-server: set a customer's durable locale (WhatsApp pipeline /
   * USSD gateway). Delegates to setStickyLocale (Redis mirror +
   * customers.language sync).
   */
  setCustomerLocale: internalProcedure
    .input(z.object({
      tenantId: z.string().min(1).max(36),
      phone: z.string().min(7).max(30),
      locale: localeSchema,
    }))
    .mutation(async ({ input }) => {
      await setStickyLocale(input.tenantId, input.phone, input.locale);
      return { ok: true as const };
    }),
});
