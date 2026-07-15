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

  // Bulk CSV import — accepts pre-parsed rows from the client
  importCsv: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      rows: z.array(z.object({
        sku: z.string().min(1).max(100),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        category: z.string().optional(),
        price: z.string().regex(/^\d+(\.\d{1,2})?$/, "Price must be a valid number"),
        currency: z.string().length(3).default("NGN"),
        stockQuantity: z.number().int().min(0).default(0),
        lowStockThreshold: z.number().int().min(0).default(10),
        imageUrl: z.string().optional(),
      })).min(1).max(500),
      skipDuplicates: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const results = { inserted: 0, skipped: 0, errors: [] as string[] };
      for (const row of input.rows) {
        try {
          const id = nanoid();
          await db.createProduct({
            id,
            tenantId: input.tenantId,
            sku: row.sku,
            name: row.name,
            description: row.description,
            category: row.category,
            price: row.price,
            currency: row.currency || "NGN",
            stockQuantity: row.stockQuantity ?? 0,
            lowStockThreshold: row.lowStockThreshold ?? 10,
            imageUrl: row.imageUrl || undefined,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          results.inserted++;
        } catch (e: any) {
          if (input.skipDuplicates && (e.message?.includes("duplicate") || e.message?.includes("unique"))) {
            results.skipped++;
          } else {
            results.errors.push(`SKU ${row.sku}: ${e.message}`);
          }
        }
      }
      return results;
    }),

  // Dry-run validation before import
  validateCsv: protectedProcedure
    .input(z.object({
      rows: z.array(z.object({
        sku: z.string(),
        name: z.string(),
        price: z.string(),
      })),
    }))
    .query(async ({ input }) => {
      const issues: Array<{ row: number; field: string; message: string }> = [];
      input.rows.forEach((row, i) => {
        if (!row.sku?.trim()) issues.push({ row: i + 1, field: "sku", message: "SKU is required" });
        if (!row.name?.trim()) issues.push({ row: i + 1, field: "name", message: "Name is required" });
        if (!row.price?.trim() || !/^\d+(\.\d{1,2})?$/.test(row.price.trim())) {
          issues.push({ row: i + 1, field: "price", message: "Price must be a valid number (e.g. 1500.00)" });
        }
      });
      return { valid: issues.length === 0, issues, rowCount: input.rows.length };
    }),
});
