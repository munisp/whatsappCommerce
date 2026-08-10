/**
 * Medusa Commerce Router
 * Exposes Medusa v2 product/order/cart/pricing data via tRPC.
 * Falls back gracefully when MEDUSA_API_URL is not configured.
 */
import { z } from "zod";
import { protectedProcedure, publicProcedure, adminProcedure, router } from "../_core/trpc";
import {
  isMedusaConfigured,
  listProducts,
  getProduct,
  listCollections,
  listCategories,
  listOrders,
  getOrder,
  listPriceLists,
  createPriceList,
  listPromotions,
  listRegions,
  createCart,
  addToCart,
  getCart,
} from "../services/medusaAdapter";
import { getDb } from "../db";
import { whatsappMenus, whatsappMenuItems, tenantIntegrations } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { fetchMedusaCatalog, getMedusaIntegrationConfig } from "../services/integrationSync";
import { encryptSecret } from "../services/crypto/secrets";
import { randomUUID } from "crypto";

function getMedusaTenantId(ctx: { user?: { tenantId?: string | null } | null }): string {
  return ctx.user?.tenantId ?? "default";
}

export const medusaRouter = router({
  /** Check if Medusa is configured */
  isConfigured: publicProcedure.query(() => ({
    configured: isMedusaConfigured(),
    url: process.env.MEDUSA_API_URL ?? null,
  })),

  /** List products from Medusa (or return empty if not configured) */
  listProducts: publicProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      q: z.string().optional(),
      collection_id: z.array(z.string()).optional(),
      category_id: z.array(z.string()).optional(),
    }))
    .query(async ({ input }) => {
      if (!isMedusaConfigured()) return { products: [], count: 0, configured: false };
      const result = await listProducts(input);
      return { ...result, configured: true };
    }),

  /** Get single product */
  getProduct: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      if (!isMedusaConfigured()) return { product: null, configured: false };
      const result = await getProduct(input.id);
      return { ...result, configured: true };
    }),

  /** List collections */
  listCollections: publicProcedure.query(async () => {
    if (!isMedusaConfigured()) return { collections: [], configured: false };
    const result = await listCollections();
    return { ...result, configured: true };
  }),

  /** List categories */
  listCategories: publicProcedure.query(async () => {
    if (!isMedusaConfigured()) return { product_categories: [], configured: false };
    const result = await listCategories();
    return { ...result, configured: true };
  }),

  /** List regions (multi-currency) */
  listRegions: publicProcedure.query(async () => {
    if (!isMedusaConfigured()) return { regions: [], configured: false };
    const result = await listRegions();
    return { ...result, configured: true };
  }),

  /** List orders (admin) */
  listOrders: protectedProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      customer_id: z.string().optional(),
    }))
    .query(async ({ input }) => {
      if (!isMedusaConfigured()) return { orders: [], count: 0, configured: false };
      const result = await listOrders(input);
      return { ...result, configured: true };
    }),

  /** Get single order */
  getOrder: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      if (!isMedusaConfigured()) return { order: null, configured: false };
      const result = await getOrder(input.id);
      return { ...result, configured: true };
    }),

  /** List price lists (B2B wholesale) */
  listPriceLists: protectedProcedure.query(async () => {
    if (!isMedusaConfigured()) return { price_lists: [], configured: false };
    const result = await listPriceLists();
    return { ...result, configured: true };
  }),

  /** Create price list (B2B wholesale tier) */
  createPriceList: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      type: z.enum(["sale", "override"]),
      prices: z.array(z.object({
        variant_id: z.string(),
        amount: z.number().positive(),
        currency_code: z.string().length(3),
        min_quantity: z.number().optional(),
      })),
    }))
    .mutation(async ({ input }) => {
      if (!isMedusaConfigured()) throw new Error("Medusa not configured");
      return createPriceList(input);
    }),

  /** List promotions */
  listPromotions: protectedProcedure.query(async () => {
    if (!isMedusaConfigured()) return { promotions: [], configured: false };
    const result = await listPromotions();
    return { ...result, configured: true };
  }),

  /** Create cart */
  createCart: publicProcedure
    .input(z.object({ regionId: z.string() }))
    .mutation(async ({ input }) => {
      if (!isMedusaConfigured()) throw new Error("Medusa not configured");
      return createCart(input.regionId);
    }),

  /** Add item to cart */
  addToCart: publicProcedure
    .input(z.object({ cartId: z.string(), variantId: z.string(), quantity: z.number().positive() }))
    .mutation(async ({ input }) => {
      if (!isMedusaConfigured()) throw new Error("Medusa not configured");
      return addToCart(input.cartId, input.variantId, input.quantity);
    }),

  /** Get cart */
  getCart: publicProcedure
    .input(z.object({ cartId: z.string() }))
    .query(async ({ input }) => {
      if (!isMedusaConfigured()) throw new Error("Medusa not configured");
      return getCart(input.cartId);
    }),

  /** Fetch Medusa product catalog variants for the picker dialog */
  getCatalogForPicker: protectedProcedure
    .query(async ({ ctx }) => {
      const tenantId = getMedusaTenantId(ctx);
      const products = await fetchMedusaCatalog(tenantId);
      return { products, configured: isMedusaConfigured() || products.length > 0 };
    }),

  /** Import selected Medusa product variants as menu items into a given menu */
  importProductsToMenu: protectedProcedure
    .input(z.object({
      menuId: z.string(),
      products: z.array(z.object({
        id: z.string(),
        title: z.string(),
        price: z.number(),
        currency: z.string(),
        stock: z.number(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = getMedusaTenantId(ctx);
      const [menu] = await db.select({ id: whatsappMenus.id })
        .from(whatsappMenus)
        .where(eq(whatsappMenus.id, input.menuId))
        .limit(1);
      if (!menu) throw new Error("Menu not found");
      const existing = await db.select({ sortOrder: whatsappMenuItems.sortOrder })
        .from(whatsappMenuItems)
        .where(eq(whatsappMenuItems.menuId, input.menuId));
      const maxSort = existing.reduce((m, r) => Math.max(m, r.sortOrder), 0);
      const inserted = await Promise.all(
        input.products.map((p, i) =>
          db.insert(whatsappMenuItems).values({
            id: randomUUID(),
            menuId: input.menuId,
            tenantId,
            type: "list_item",
            title: p.title,
            description: `${p.currency} ${p.price.toFixed(2)} · Stock: ${p.stock}`,
            payload: `product:${p.id}`,
            sortOrder: maxSort + i + 1,
            metadata: { medusaVariantId: p.id, price: p.price, currency: p.currency, stock: p.stock },
          }).returning({ id: whatsappMenuItems.id }),
        ),
      );
      return { imported: inserted.length };
    }),

  /**
   * Configure the Medusa connection for a tenant (admin only).
   *
   * Persists credentials to tenant_integrations (integrationType "medusa") —
   * the authoritative store consumed by every per-tenant sync path
   * (integrationSync.syncOrderToMedusa / fetchMedusaCatalog, the
   * odooMedusaBridge inventory push and the cron heartbeats).
   *
   * NOTE: server/services/medusaAdapter.ts reads process.env at module load
   * and is NOT tenant-aware.  The MEDUSA_API_URL / MEDUSA_ADMIN_API_KEY env
   * vars therefore remain a global bootstrap for the env-based adapter paths
   * above; the DB row written here always takes precedence inside the
   * per-tenant resolver (getMedusaIntegrationConfig).  Runtime mutation of
   * process.env has been removed — env config must be set at deploy time.
   */
  configure: adminProcedure
    .input(z.object({
      tenantId: z.string(),
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
      publishableKey: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const baseUrl = input.baseUrl.replace(/\/+$/, "");
      const existing = await db
        .select({ id: tenantIntegrations.id })
        .from(tenantIntegrations)
        .where(and(
          eq(tenantIntegrations.tenantId, input.tenantId),
          eq(tenantIntegrations.integrationType, "medusa"),
        ))
        .limit(1);
      // Admin API key is a secret — encrypt at rest (v1: envelope); reads
      // decrypt transparently via decryptSecret (legacy plaintext passthrough).
      const encApiKey = encryptSecret(input.apiKey);
      if (existing[0]) {
        await db.update(tenantIntegrations)
          .set({
            baseUrl,
            apiKey: encApiKey,
            apiSecret: input.publishableKey ?? null,
            status: "active",
            enabledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tenantIntegrations.id, existing[0].id));
        return { ok: true, id: existing[0].id, message: "Medusa configuration saved" };
      }
      const id = randomUUID();
      await db.insert(tenantIntegrations).values({
        id,
        tenantId: input.tenantId,
        integrationType: "medusa",
        displayName: "Medusa Commerce",
        baseUrl,
        apiKey: encApiKey,
        apiSecret: input.publishableKey ?? null,
        status: "active",
        enabledAt: new Date(),
      });
      return { ok: true, id, message: "Medusa configuration saved" };
    }),

  /**
   * Real connection test: GET {baseUrl}/admin/products?limit=1 with the
   * x-medusa-access-token header.  Returns the real error when the instance
   * is unreachable or the admin API key is rejected.
   */
  testConnection: protectedProcedure
    .input(z.object({
      tenantId: z.string().optional(),
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const tenantId = input.tenantId ?? getMedusaTenantId(ctx);
      // Cross-tenant guard: only admins may test another tenant's connection.
      if (ctx.user.role !== "admin" && input.tenantId && input.tenantId !== getMedusaTenantId(ctx)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot manage Medusa integration for another tenant",
        });
      }
      const baseUrl = input.baseUrl.replace(/\/+$/, "");
      let status: "connected" | "error" = "error";
      let error: string | null = null;
      try {
        const res = await fetch(`${baseUrl}/admin/products?limit=1`, {
          headers: { "x-medusa-access-token": input.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          status = "connected";
        } else {
          const body = await res.text().catch(() => "");
          error = `Medusa admin API returned status ${res.status}: ${body.slice(0, 300)}`;
        }
      } catch (err: any) {
        error = err?.message ?? String(err);
      }
      // Reflect the outcome on the tenant_integrations row when one exists.
      const [existing] = await db
        .select({ id: tenantIntegrations.id })
        .from(tenantIntegrations)
        .where(and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.integrationType, "medusa"),
        ))
        .limit(1);
      if (existing) {
        await db.update(tenantIntegrations)
          .set({
            status: status === "connected" ? "active" : "error",
            lastHealthCheck: new Date(),
            lastHealthStatus: status === "connected" ? "ok" : "error",
            lastError: error,
            updatedAt: new Date(),
          })
          .where(eq(tenantIntegrations.id, existing.id));
      }
      return { success: status === "connected", status, error };
    }),

  /** Effective Medusa configuration for the caller's tenant (DB or env bootstrap). */
  getTenantConfig: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await getMedusaIntegrationConfig(getMedusaTenantId(ctx));
    if (!cfg) return { configured: false, baseUrl: null, source: null };
    return { configured: true, baseUrl: cfg.baseUrl, source: cfg.source };
    }),
});
