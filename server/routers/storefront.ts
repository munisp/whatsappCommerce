/**
 * W27 storefront router.
 *
 * Public surface (hardened per tracking.ts exemplar): `getBySlug` returns a
 * PII-scrubbed storefront view — business branding, active catalog,
 * click-to-chat CTA, and (opt-in + approved KYB only) location. Hidden or
 * unknown slugs both 404 so visibility cannot be probed; per-IP rate limit
 * (60 req/min) mirrors geo.discover (fail-closed in prod, fail-open in dev).
 *
 * Tenant self-service (`merchant.*`): session-tenant scoped
 * (ctx.user.tenantId, never caller-supplied) — same pattern as geo.merchant.
 * Merchants manage slug, theme color, hero text, visibility toggle,
 * location publication opt-in, and the storefront default locale.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { ENV } from "../_core/env";
import { getDb } from "../db";
import { storefronts, tenants } from "../../drizzle/schema";
import {
  buildDefaultSlug,
  getStorefrontPublicView,
  hasApprovedKyb,
  upsertStorefront,
  validateSlug,
} from "../services/storefront";
import { isLocale, LOCALE_NAMES, SUPPORTED_LOCALES } from "../services/i18n";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function requireTenantId(ctx: { user: { tenantId?: string | null } }): string {
  const tenantId = ctx.user.tenantId;
  if (!tenantId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
  }
  return tenantId;
}

const themeColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "theme color must be a hex color like #075E54");

const settingsInputSchema = z.object({
  slug: z.string().min(1).max(80).optional(),
  heroText: z.string().max(280).nullable().optional(),
  themeColor: themeColorSchema.optional(),
  isVisible: z.boolean().optional(),
  showLocation: z.boolean().optional(),
  defaultLocale: z.string().max(8).optional(),
});

export const storefrontRouter = router({
  /**
   * Public storefront by slug. authz:exempt — public shareable surface;
   * returns only the PII-scrubbed StorefrontPublicView; hidden storefronts
   * are indistinguishable from unknown slugs (both NOT_FOUND).
   */
  getBySlug: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(80) }))
    .query(async ({ input, ctx }) => {
      const ip =
        (ctx.req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
        ctx.req?.socket?.remoteAddress ||
        "unknown";
      const { checkRateLimit } = await import("../_core/rateLimit");
      const decision = await checkRateLimit(`storefront:get:${ip}`, 60, 60, ENV.isProduction);
      if (!decision.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded — retry later",
        });
      }
      const db = await requireDb();
      const view = await getStorefrontPublicView(db, input.slug.toLowerCase());
      if (!view) throw new TRPCError({ code: "NOT_FOUND", message: "Storefront not found" });
      return view;
    }),

  /**
   * === W51 PROMOS === storefront highlights: featured pins + most-ordered
   * products (90-day sales) + active promos for web storefront rendering
   * (tenant-portal / Medusa widget consumption). Public read of the same
   * data the storefront already exposes; per-IP rate-limited like getBySlug.
   */
  highlights: publicProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const ip =
        (ctx.req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
        ctx.req?.socket?.remoteAddress ||
        "unknown";
      const { checkRateLimit } = await import("../_core/rateLimit");
      const decision = await checkRateLimit(`storefront:highlights:${ip}`, 60, 60, ENV.isProduction);
      if (!decision.allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Rate limit exceeded — retry later" });
      }
      const db = await requireDb();
      const { getPopularProducts, getPromoSpotSettings, getSpotlightPromos, rankForDisplay } =
        await import("../services/promoSpotlight");
      const { products } = await import("../../drizzle/schema");
      const { and } = await import("drizzle-orm");
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1)
        .catch(() => [] as any[]);
      const settings = (tenant?.settings ?? null) as Record<string, unknown> | null;
      const spot = getPromoSpotSettings(settings);
      const [popular, promos, rows] = await Promise.all([
        getPopularProducts(db, input.tenantId, 10),
        spot.showActive ? getSpotlightPromos(db, input.tenantId, settings) : Promise.resolve([]),
        db.select({
          id: products.id, name: products.name, price: products.price,
          currency: products.currency, imageUrl: products.imageUrl,
        }).from(products)
          .where(and(eq(products.tenantId, input.tenantId), eq(products.status, "active")))
          .limit(100)
          .catch(() => [] as any[]),
      ]);
      const popularRank = new Map(popular.map((r, i) => [r.productId, i + 1]));
      const top3 = new Set(popular.slice(0, 3).map((r) => r.productId));
      const ranked = rankForDisplay(rows as Array<{ id: string } & any>, Array.from(popularRank.keys()), spot.featuredProductIds)
        .filter((p: any) => spot.featuredProductIds.includes(p.id) || popularRank.has(p.id))
        .slice(0, 10)
        .map((p: any): { id: string; name: string; price: unknown; currency: string; imageUrl: string | null; featured: boolean; popularRank: number | null; badge: "most_ordered" | null } => ({
          id: p.id,
          name: p.name,
          price: p.price,
          currency: p.currency,
          imageUrl: p.imageUrl ?? null,
          featured: spot.featuredProductIds.includes(p.id),
          popularRank: popularRank.get(p.id) ?? null,
          badge: top3.has(p.id) ? "most_ordered" as const : null,
        }));
      return {
        featured: ranked.filter((p: any) => p.featured),
        popular: ranked,
        promos,
      };
    }),

  merchant: router({
    /** Read the tenant's storefront row (null until first save) + derived URL. */
    getSettings: protectedProcedure.query(async ({ ctx }) => {
      const tenantId = requireTenantId(ctx);
      const db = await requireDb();
      const [sf] = await db
        .select()
        .from(storefronts)
        .where(eq(storefronts.tenantId, tenantId))
        .limit(1);
      const [tenant] = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return {
        storefront: sf ?? null,
        /** Preview of the auto-generated default slug (deterministic). */
        defaultSlug: sf?.slug ?? buildDefaultSlug(tenantId, tenant?.name ?? "shop"),
        kybApproved: await hasApprovedKyb(db, tenantId),
        supportedLocales: SUPPORTED_LOCALES.map((l) => ({ code: l, name: LOCALE_NAMES[l] })),
      };
    }),

    /** Upsert storefront settings (slug/theme/hero/visibility/location/locale). */
    upsertSettings: protectedProcedure
      .input(settingsInputSchema)
      .mutation(async ({ ctx, input }) => {
        const tenantId = requireTenantId(ctx);
        if (input.defaultLocale != null && !isLocale(input.defaultLocale)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unsupported locale "${input.defaultLocale}" (supported: ${SUPPORTED_LOCALES.join(", ")})`,
          });
        }
        if (input.slug != null) {
          const err = validateSlug(input.slug);
          if (err) throw new TRPCError({ code: "BAD_REQUEST", message: err });
        }
        const db = await requireDb();
        // Pre-check slug ownership for a clean CONFLICT (the unique index is
        // the backstop for races).
        if (input.slug != null) {
          const [owner] = await db
            .select({ tenantId: storefronts.tenantId })
            .from(storefronts)
            .where(eq(storefronts.slug, input.slug))
            .limit(1);
          if (owner && owner.tenantId !== tenantId) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "That storefront slug is already taken — choose another",
            });
          }
        }
        const [tenant] = await db
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        try {
          const result = await upsertStorefront(db, tenantId, tenant?.name ?? "shop", {
            ...input,
            slug: input.slug?.toLowerCase(),
          });
          return result;
        } catch (e: any) {
          if (e?.code === "BAD_REQUEST") {
            throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
          }
          // Unique-index race on slug.
          if (String(e?.message ?? "").includes("storefronts_slug_uidx")) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "That storefront slug is already taken — choose another",
            });
          }
          throw e;
        }
      }),

    /** Quick visibility toggle (published/unpublished). */
    setVisibility: protectedProcedure
      .input(z.object({ isVisible: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const tenantId = requireTenantId(ctx);
        const db = await requireDb();
        const [existing] = await db
          .select({ id: storefronts.id })
          .from(storefronts)
          .where(eq(storefronts.tenantId, tenantId))
          .limit(1);
        if (!existing) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Save storefront settings first (storefront.merchant.upsertSettings)",
          });
        }
        await db
          .update(storefronts)
          .set({ isVisible: input.isVisible, updatedAt: new Date() })
          .where(eq(storefronts.id, existing.id));
        return { isVisible: input.isVisible };
      }),
  }),
});
