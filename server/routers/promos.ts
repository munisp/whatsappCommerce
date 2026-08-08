/**
 * Promo code management (tenant admin) — CRUD over tenants.settings.promos.
 *
 * Runtime validation/redemption lives in server/services/promos.ts; this
 * router is only the admin surface. Every procedure is tenant-scoped via
 * assertTenantAccess.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { assertTenantAccess, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { getPromosFromSettings, findPromo, validatePromo, type Promo } from "../services/promos";

const promoSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "code must be alphanumeric (with - or _)"),
  type: z.enum(["percent", "fixed"]),
  // percent: 0–100; fixed: major-units amount off (e.g. 500 = ₦500.00).
  value: z.number().min(0).max(1_000_000),
  minTotal: z.number().min(0).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  maxUses: z.number().int().min(1).optional(),
});

async function readPromos(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tenantId: string) {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
  return { settings: (tenant.settings ?? {}) as Record<string, unknown>, promos: getPromosFromSettings(tenant.settings) };
}

async function writePromos(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  tenantId: string,
  settings: Record<string, unknown>,
  promos: Promo[],
) {
  await db
    .update(tenants)
    .set({ settings: { ...settings, promos }, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
}

export const promosRouter = router({
  /** List all promo codes for a tenant. */
  list: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { promos } = await readPromos(db, input.tenantId);
      return { promos };
    }),

  /** Create a promo code. Codes are unique per tenant (case-insensitive). */
  create: protectedProcedure
    .input(z.object({ tenantId: z.string(), promo: promoSchema }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      if (input.promo.type === "percent" && input.promo.value > 100) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "percent promo value must be <= 100" });
      }
      const { settings, promos } = await readPromos(db, input.tenantId);
      if (findPromo(promos, input.promo.code)) {
        throw new TRPCError({ code: "CONFLICT", message: `Promo code ${input.promo.code} already exists` });
      }
      const promo: Promo = { ...input.promo, usedCount: 0 };
      await writePromos(db, input.tenantId, settings, [...promos, promo]);
      return { ok: true, promo };
    }),

  /** Update a promo (matched case-insensitively by code). */
  update: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      code: z.string(),
      patch: promoSchema.partial().omit({ code: true }),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { settings, promos } = await readPromos(db, input.tenantId);
      const existing = findPromo(promos, input.code);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Promo not found" });
      const next = promos.map((p) =>
        p.code.toLowerCase() === existing.code.toLowerCase()
          ? { ...p, ...input.patch }
          : p,
      );
      await writePromos(db, input.tenantId, settings, next);
      return { ok: true };
    }),

  /** Delete a promo code. */
  delete: protectedProcedure
    .input(z.object({ tenantId: z.string(), code: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { settings, promos } = await readPromos(db, input.tenantId);
      const existing = findPromo(promos, input.code);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Promo not found" });
      await writePromos(
        db,
        input.tenantId,
        settings,
        promos.filter((p) => p.code.toLowerCase() !== existing.code.toLowerCase()),
      );
      return { ok: true };
    }),

  /** Validate a code against a cart total (admin preview / pre-checkout). */
  validate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      code: z.string(),
      cartTotal: z.number().min(0),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return validatePromo(db, input.tenantId, input.code, input.cartTotal);
    }),
});
