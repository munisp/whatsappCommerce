import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { productImageCollections } from "../../drizzle/schema";
import { eq, desc, count, sql } from "drizzle-orm";
import { avg } from "drizzle-orm";
import { storagePut } from "../storage";

function getTenantId(ctx: { user: { tenantId?: string | null; id: number } }): string {
  return ctx.user.tenantId ?? `user-${ctx.user.id}`;
}

// Nigerian FMCG class registry (matches finetune.py class list)
const FMCG_CLASSES: Record<string, string> = {
  indomie_pack: "Indomie Noodles Pack",
  maggi_cube: "Maggi Seasoning Cube",
  knorr_cube: "Knorr Seasoning Cube",
  royco_cube: "Royco Seasoning Cube",
  dano_milk: "Dano Milk Sachet",
  peak_milk: "Peak Milk Sachet",
  cowbell_sachet: "Cowbell Milk Sachet",
  bigi_cola: "Bigi Cola Bottle",
  coca_cola_bottle: "Coca-Cola Bottle",
  coca_cola_can: "Coca-Cola Can",
  malta_guinness: "Malta Guinness Bottle",
  eva_water: "Eva Water Bottle",
  pure_water_sachet: "Pure Water Sachet (Nylon)",
  chivita_juice: "Chivita Juice Pack",
  gino_tomato: "Gino Tomato Paste Sachet",
  tasty_tom: "Tasty Tom Tomato Paste",
  mama_gold_rice: "Mama Gold Rice Bag",
  caprice_rice: "Caprice Rice Bag",
  garri_bag: "Garri Bag",
  devon_kings_oil: "Devon King's Vegetable Oil",
  mamador_oil: "Mamador Vegetable Oil",
  omo_sachet: "Omo Detergent Sachet",
  ariel_sachet: "Ariel Detergent Sachet",
  key_soap: "Key Soap Bar",
  dettol_soap: "Dettol Soap Bar",
  vaseline_sachet: "Vaseline Petroleum Jelly Sachet",
  robb: "Robb Balm",
  cabin_biscuit: "Cabin Biscuit Pack",
  digestive_biscuit: "McVitie's Digestive Biscuit",
  dangote_noodles: "Dangote Instant Noodles",
};

export const productImagesRouter = router({
  // List all classes with image counts
  listClasses: publicProcedure.query(async () => {
    const db = (await getDb())!;
    const counts = await db
      .select({
        className: productImageCollections.className,
        count: count(),
        usedInTraining: sql<number>`SUM(CASE WHEN ${productImageCollections.usedInTraining} THEN 1 ELSE 0 END)`,
        avgQuality: avg(productImageCollections.qualityScore),
        qualityGatedCount: sql<number>`SUM(CASE WHEN COALESCE(${productImageCollections.qualityScore}, 0) >= 3 THEN 1 ELSE 0 END)`,
      })
      .from(productImageCollections)
      .groupBy(productImageCollections.className);

    const countMap = Object.fromEntries(counts.map(c => [c.className, {
      total: Number(c.count),
      trained: Number(c.usedInTraining),
      avgQuality: c.avgQuality ? parseFloat(String(c.avgQuality)) : null,
      qualityGated: Number(c.qualityGatedCount),
    }]));

    return Object.entries(FMCG_CLASSES).map(([className, displayName]) => ({
      className,
      displayName,
      totalImages: countMap[className]?.total ?? 0,
      trainedImages: countMap[className]?.trained ?? 0,
      avgQualityScore: countMap[className]?.avgQuality ?? null,
      qualityImages: countMap[className]?.qualityGated ?? 0, // images with score >= 3
      isReady: (countMap[className]?.total ?? 0) >= 2,
    }));
  }),

  // List images for a specific class
  listByClass: publicProcedure
    .input(z.object({ className: z.string() }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      return db
        .select()
        .from(productImageCollections)
        .where(eq(productImageCollections.className, input.className))
        .orderBy(desc(productImageCollections.createdAt));
    }),

  // Upload a product image (base64 encoded from camera or file input)
  uploadImage: protectedProcedure
    .input(z.object({
      className: z.string().min(1),
      imageBase64: z.string().min(1), // data:image/jpeg;base64,...
      source: z.enum(["camera", "upload", "internet"]).default("upload"),
      notes: z.string().optional(),
      qualityScore: z.number().min(1).max(5).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx);

      // Decode base64 image
      const matches = input.imageBase64.match(/^data:(.+);base64,(.+)$/);
      if (!matches) throw new Error("Invalid base64 image format");
      const mimeType = matches[1];
      const buffer = Buffer.from(matches[2], "base64");
      const ext = mimeType.includes("png") ? "png" : "jpg";
      const fileKey = `product-images/${input.className}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const { url } = await storagePut(fileKey, buffer, mimeType);

      const displayName = FMCG_CLASSES[input.className] ?? input.className;
      const [record] = await db.insert(productImageCollections).values({
        id: crypto.randomUUID(),
        tenantId,
        className: input.className,
        displayName,
        imageUrl: url,
        imageKey: fileKey,
        source: input.source,
        notes: input.notes,
        uploadedBy: String(ctx.user.id),
        qualityScore: input.qualityScore,
      }).returning();

      return { success: true, id: record.id, url };
    }),

  // Batch upload multiple images for a single class
  batchUpload: protectedProcedure
    .input(z.object({
      className: z.string().min(1),
      images: z.array(z.object({
        imageBase64: z.string().min(1),
        source: z.enum(["camera", "upload", "internet"]).default("upload"),
        notes: z.string().optional(),
        qualityScore: z.number().min(1).max(5).optional(),
      })).min(1).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx);
      const displayName = FMCG_CLASSES[input.className] ?? input.className;
      const results: { id: string; url: string }[] = [];
      const errors: string[] = [];
      for (let i = 0; i < input.images.length; i++) {
        const img = input.images[i];
        try {
          const matches = img.imageBase64.match(/^data:(.+);base64,(.+)$/);
          if (!matches) { errors.push(`Image ${i + 1}: Invalid base64 format`); continue; }
          const mimeType = matches[1];
          const buffer = Buffer.from(matches[2], "base64");
          const ext = mimeType.includes("png") ? "png" : "jpg";
          const fileKey = `product-images/${input.className}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
          const { url } = await storagePut(fileKey, buffer, mimeType);
          const [record] = await db.insert(productImageCollections).values({
            id: crypto.randomUUID(),
            tenantId,
            className: input.className,
            displayName,
            imageUrl: url,
            imageKey: fileKey,
            source: img.source,
            notes: img.notes,
            uploadedBy: String(ctx.user.id),
            qualityScore: img.qualityScore,
          }).returning();
          results.push({ id: record.id, url });
        } catch (e) {
          errors.push(`Image ${i + 1}: ${e instanceof Error ? e.message : "Unknown error"}`);
        }
      }
      return { uploaded: results.length, failed: errors.length, errors, results };
    }),

  // Rate image quality
  rateImage: protectedProcedure
    .input(z.object({ id: z.string(), qualityScore: z.number().min(1).max(5) }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.update(productImageCollections)
        .set({ qualityScore: input.qualityScore })
        .where(eq(productImageCollections.id, input.id));
      return { success: true };
    }),

  // Delete an image
  deleteImage: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = (await getDb())!;
      await db.delete(productImageCollections)
        .where(eq(productImageCollections.id, input.id));
      return { success: true };
    }),

  // Get dataset stats
  datasetStats: publicProcedure.query(async () => {
    const db = (await getDb())!;
    const total = await db.select({ count: count() }).from(productImageCollections);
    const byClass = await db
      .select({
        className: productImageCollections.className,
        count: count(),
      })
      .from(productImageCollections)
      .groupBy(productImageCollections.className);

    const classesReady = byClass.filter(c => Number(c.count) >= 2).length;
    return {
      totalImages: Number(total[0]?.count ?? 0),
      classesWithImages: byClass.length,
      classesReady,
      totalClasses: Object.keys(FMCG_CLASSES).length,
      byClass: byClass.map(c => ({ className: c.className, count: Number(c.count) })),
    };
  }),

  // Export dataset manifest (for synthetic pipeline)
  exportManifest: protectedProcedure.mutation(async () => {
    const db = (await getDb())!;
    const images = await db
      .select()
      .from(productImageCollections)
      .orderBy(productImageCollections.className, desc(productImageCollections.createdAt));

    const manifest: Record<string, { imageUrl: string; imageKey: string; source: string }[]> = {};
    for (const img of images) {
      if (!manifest[img.className]) manifest[img.className] = [];
      manifest[img.className].push({ imageUrl: img.imageUrl, imageKey: img.imageKey, source: img.source });
    }

    // Mark all as used in training
    await db.update(productImageCollections)
      .set({ usedInTraining: true });

    return { manifest, totalImages: images.length, classCount: Object.keys(manifest).length };
  }),
});
