import { z } from "zod";
import { nanoid } from "nanoid";
import { router, protectedProcedure } from "../_core/trpc";
import * as db from "../db";

export const productRouter = router({
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      limit: z.number().default(50),
      offset: z.number().default(0),
      search: z.string().optional(),
    }))
    .query(async ({ input }) => {
      return db.getProducts(input.tenantId, input.limit, input.offset, input.search);
    }),

  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      return db.getProductStats(input.tenantId);
    }),

  create: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      sku: z.string().min(1).max(100),
      name: z.string().min(1).max(255),
      description: z.string().optional(),
      category: z.string().optional(),
      price: z.string(),
      currency: z.string().length(3).default("USD"),
      imageUrl: z.string().url().optional(),
      stockQuantity: z.number().int().min(0).default(0),
      lowStockThreshold: z.number().int().min(0).default(10),
    }))
    .mutation(async ({ input }) => {
      const id = nanoid();
      await db.createProduct({ id, ...input, status: "active" });
      return { id, ...input };
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      tenantId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.string().optional(),
      stockQuantity: z.number().int().min(0).optional(),
      status: z.enum(["active", "inactive", "archived"]).optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, tenantId, ...data } = input;
      await db.updateProduct(id, tenantId, data);
      return { success: true };
    }),
});

