/**
 * W25 geospatial merchant discovery router.
 *
 * Customer-facing surface (public, unauthenticated via WhatsApp location pin
 * or browser geolocation): `discover`, `listCategories`. PRIVACY DESIGN: the
 * customer's lat/lng is a TRANSIENT query input only — it is never stored,
 * never logged with an identity, and never attached to a customer record.
 *
 * Tenant-guarded surface (merchant self-service): `merchant.setLocation`,
 * `merchant.getLocation`, `merchant.setDiscoverable` — all scoped to
 * ctx.user.tenantId (session tenant; never caller-supplied).
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { merchantLocations, sponsoredListings } from "../../drizzle/schema";
import {
  discoverNearby,
  encodeGeohash,
  listCategories,
  maxRadiusKm,
  RADIUS_QUICK_OPTIONS,
} from "../services/geoDiscovery";

const latSchema = z.number().min(-90).max(90);
const lngSchema = z.number().min(-180).max(180);

const openHoursSchema = z.record(
  z.string(),
  z.array(z.tuple([z.string(), z.string()])),
);

const locationInputSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  latitude: latSchema,
  longitude: lngSchema,
  addressLine: z.string().max(255).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  serviceRadiusKm: z.number().positive().max(1000).optional(),
  deliveryZones: z.array(z.object({
    name: z.string(),
    lat: latSchema,
    lng: lngSchema,
    radiusKm: z.number().positive(),
  })).optional(),
  openHours: openHoursSchema.optional(),
});

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function clampRadiusKm(km: number | undefined, fallback: number): number {
  const max = maxRadiusKm();
  if (km == null) return Math.min(fallback, max);
  return Math.min(Math.max(km, 0.1), max);
}

export const geoRouter = router({
  /**
   * Customer-facing geo search. authz:exempt — public discovery surface;
   * returns only merchants who explicitly opted in (discoverable=true);
   * customer location is transient (never persisted).
   */
  discover: publicProcedure
    .input(z.object({
      lat: latSchema,
      lng: lngSchema,
      radiusKm: z.number().positive().max(1000).optional(),
      category: z.string().max(128).optional(),
      query: z.string().max(200).optional(),
      openNow: z.boolean().optional(),
      cursor: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await requireDb();
      // Cursor is an opaque page index (0-based, decimal string).
      const page = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
      const result = await discoverNearby({
        lat: input.lat,
        lng: input.lng,
        radiusKm: input.radiusKm,
        category: input.category,
        query: input.query,
        openNow: input.openNow,
        page,
      }, db);
      return {
        ...result,
        nextCursor: result.hasMore ? String(result.page + 1) : null,
        radiusQuickOptions: RADIUS_QUICK_OPTIONS,
      };
    }),

  /** Customer-facing category menu tree (from the FMCG taxonomy). */
  listCategories: publicProcedure.query(async () => {
    const db = await requireDb();
    return listCategories(db);
  }),

  merchant: router({
    /** Upsert the tenant's merchant_locations row (single-branch model). */
    setLocation: protectedProcedure
      .input(locationInputSchema)
      .mutation(async ({ ctx, input }) => {
        const tenantId = ctx.user.tenantId;
        if (!tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
        }
        const db = await requireDb();
        const geohash = encodeGeohash(input.latitude, input.longitude);
        const serviceRadiusKm = clampRadiusKm(input.serviceRadiusKm, 5).toFixed(3);
        const values = {
          tenantId,
          label: input.label ?? "Main branch",
          latitude: input.latitude.toFixed(7),
          longitude: input.longitude.toFixed(7),
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          country: input.country ?? null,
          serviceRadiusKm,
          deliveryZones: input.deliveryZones ?? null,
          openHours: input.openHours ?? null,
          geohash,
          updatedAt: new Date(),
        };
        const [existing] = await db
          .select({ id: merchantLocations.id })
          .from(merchantLocations)
          .where(eq(merchantLocations.tenantId, tenantId))
          .orderBy(desc(merchantLocations.createdAt))
          .limit(1);
        if (existing) {
          await db.update(merchantLocations).set(values)
            .where(eq(merchantLocations.id, existing.id));
          return { id: existing.id, geohash, updated: true };
        }
        const [row] = await db.insert(merchantLocations).values(values).returning();
        return { id: row.id, geohash, updated: false };
      }),

    /** Read the tenant's own merchant_locations row (null when unset). */
    getLocation: protectedProcedure.query(async ({ ctx }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
      }
      const db = await requireDb();
      const [row] = await db
        .select()
        .from(merchantLocations)
        .where(eq(merchantLocations.tenantId, tenantId))
        .orderBy(desc(merchantLocations.createdAt))
        .limit(1);
      return row ?? null;
    }),

    /** Toggle discoverability + service radius + opening hours. */
    setDiscoverable: protectedProcedure
      .input(z.object({
        discoverable: z.boolean(),
        serviceRadiusKm: z.number().positive().max(1000).optional(),
        openHours: openHoursSchema.optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const tenantId = ctx.user.tenantId;
        if (!tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
        }
        const db = await requireDb();
        const [existing] = await db
          .select({ id: merchantLocations.id })
          .from(merchantLocations)
          .where(eq(merchantLocations.tenantId, tenantId))
          .orderBy(desc(merchantLocations.createdAt))
          .limit(1);
        if (!existing) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Set a location first (geo.merchant.setLocation)",
          });
        }
        const patch: Record<string, unknown> = {
          discoverable: input.discoverable,
          updatedAt: new Date(),
        };
        if (input.serviceRadiusKm != null) {
          patch.serviceRadiusKm = clampRadiusKm(input.serviceRadiusKm, 5).toFixed(3);
        }
        if (input.openHours != null) patch.openHours = input.openHours;
        await db.update(merchantLocations).set(patch)
          .where(eq(merchantLocations.id, existing.id));
        return { id: existing.id, discoverable: input.discoverable };
      }),

    /**
     * Create a sponsored placement for this tenant. Requires a discoverable
     * merchant location first — a placement is location-aware (only shown to
     * customers searching inside its area), so a tenant without a published
     * location cannot meaningfully sponsor anything. All money is integer
     * cents; created rows go live immediately (status 'active').
     */
    createSponsoredListing: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(160),
        categories: z.array(z.string().min(1).max(128)).max(20).optional(),
        centerLat: latSchema,
        centerLng: lngSchema,
        radiusKm: z.number().min(0.5).max(50),
        bidCents: z.number().int().min(0),
        dailyBudgetCents: z.number().int().positive(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const tenantId = ctx.user.tenantId;
        if (!tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
        }
        const db = await requireDb();
        const [location] = await db
          .select({ id: merchantLocations.id, discoverable: merchantLocations.discoverable })
          .from(merchantLocations)
          .where(eq(merchantLocations.tenantId, tenantId))
          .orderBy(desc(merchantLocations.createdAt))
          .limit(1);
        if (!location || !location.discoverable) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Set your shop location and turn on discovery first — sponsored placements are shown to customers searching near your location.",
          });
        }
        const [row] = await db.insert(sponsoredListings).values({
          tenantId,
          name: input.name,
          categories: input.categories ?? [],
          centerLat: input.centerLat.toFixed(7),
          centerLng: input.centerLng.toFixed(7),
          radiusKm: input.radiusKm.toFixed(3),
          bidCents: input.bidCents,
          dailyBudgetCents: input.dailyBudgetCents,
          status: "active",
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
        }).returning();
        return row;
      }),

    /** List the tenant's sponsored placements, newest first. */
    listSponsoredListings: protectedProcedure.query(async ({ ctx }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
      }
      const db = await requireDb();
      return db
        .select()
        .from(sponsoredListings)
        .where(eq(sponsoredListings.tenantId, tenantId))
        .orderBy(desc(sponsoredListings.createdAt));
    }),

    /** Pause a placement (tenant-ownership enforced). */
    pauseSponsoredListing: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const tenantId = ctx.user.tenantId;
        if (!tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
        }
        const db = await requireDb();
        const [row] = await db
          .update(sponsoredListings)
          .set({ status: "paused", updatedAt: new Date() })
          .where(and(
            eq(sponsoredListings.id, input.id),
            eq(sponsoredListings.tenantId, tenantId),
          ))
          .returning();
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sponsored listing not found" });
        }
        return row;
      }),

    /** Resume a paused placement (only from 'paused'). */
    resumeSponsoredListing: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const tenantId = ctx.user.tenantId;
        if (!tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No tenant on session" });
        }
        const db = await requireDb();
        const [row] = await db
          .update(sponsoredListings)
          .set({ status: "active", updatedAt: new Date() })
          .where(and(
            eq(sponsoredListings.id, input.id),
            eq(sponsoredListings.tenantId, tenantId),
            eq(sponsoredListings.status, "paused"),
          ))
          .returning();
        if (!row) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only a paused sponsored listing can be resumed",
          });
        }
        return row;
      }),
  }),
});

export type GeoRouter = typeof geoRouter;
