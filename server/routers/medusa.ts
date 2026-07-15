/**
 * Medusa Commerce Router
 * Exposes Medusa v2 product/order/cart/pricing data via tRPC.
 * Falls back gracefully when MEDUSA_API_URL is not configured.
 */
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
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
});

