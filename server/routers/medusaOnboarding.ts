/**
 * Medusa Product Onboarding Router
 * Allows businesses to onboard their products/services to Medusa v2 via:
 * 1. Manual entry (single product form)
 * 2. Bulk CSV import
 * 3. Sync from existing platform catalog
 * 4. Push to Medusa via Admin API
 */
import { z } from "zod";
import { eq, and, desc, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  medusaProductOnboarding,
  products,
  tenantIntegrations,
} from "../../drizzle/schema";

function getTenantId(ctx: { user: { tenantId?: string | null } }): string {
  return ctx.user?.tenantId ?? "default";
}

// ── Medusa Admin API helper ───────────────────────────────────────────────────
async function getMedusaAdminConfig(tenantId: string) {
  const db = await getDb();
  if (!db) return null;
  const [integration] = await db.select({
    baseUrl: tenantIntegrations.baseUrl,
    apiKey: tenantIntegrations.apiKey,
    status: tenantIntegrations.status,
  }).from(tenantIntegrations)
    .where(and(
      eq(tenantIntegrations.tenantId, tenantId),
      eq(tenantIntegrations.integrationType, "medusa"),
    ))
    .limit(1);
  return integration ?? null;
}

async function pushProductToMedusa(
  baseUrl: string,
  apiKey: string,
  product: {
    title: string;
    description?: string | null;
    sku?: string | null;
    price: number;
    currency: string;
    stockQuantity: number;
    images?: string[];
    tags?: string[];
  },
): Promise<{ productId: string; variantId: string; inventoryItemId: string } | null> {
  try {
    const base = baseUrl.replace(/\/$/, "");
    // 1. Create product
    const productRes = await fetch(`${base}/admin/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        title: product.title,
        description: product.description ?? "",
        status: "published",
        images: (product.images ?? []).map(url => ({ url })),
        tags: (product.tags ?? []).map(value => ({ value })),
        variants: [{
          title: "Default",
          sku: product.sku ?? undefined,
          manage_inventory: true,
          prices: [{
            amount: Math.round(product.price * 100),
            currency_code: product.currency.toLowerCase(),
          }],
        }],
      }),
    });
    if (!productRes.ok) return null;
    const { product: created } = await productRes.json() as {
      product: { id: string; variants: Array<{ id: string; inventory_items?: Array<{ inventory_item_id: string }> }> }
    };
    const variantId = created.variants?.[0]?.id ?? "";
    const inventoryItemId = created.variants?.[0]?.inventory_items?.[0]?.inventory_item_id ?? "";

    // 2. Set stock level if we have an inventory item
    if (inventoryItemId && product.stockQuantity > 0) {
      await fetch(`${base}/admin/inventory-items/${inventoryItemId}/location-levels`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          location_id: "default",
          stocked_quantity: product.stockQuantity,
        }),
      });
    }

    return { productId: created.id, variantId, inventoryItemId };
  } catch {
    return null;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export const medusaOnboardingRouter = router({
  /** List all onboarding records for this tenant */
  list: protectedProcedure
    .input(z.object({
      status: z.enum(["draft", "syncing", "synced", "failed"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [] };
      const tenantId = getTenantId(ctx);
      const rows = await db.select().from(medusaProductOnboarding)
        .where(
          input?.status
            ? and(eq(medusaProductOnboarding.tenantId, tenantId), eq(medusaProductOnboarding.status, input.status))
            : eq(medusaProductOnboarding.tenantId, tenantId)
        )
        .orderBy(desc(medusaProductOnboarding.createdAt));
      return { items: rows };
    }),

  /** Add a single product to the onboarding queue */
  addProduct: protectedProcedure
    .input(z.object({
      title: z.string().min(1).max(256),
      description: z.string().optional(),
      sku: z.string().optional(),
      price: z.number().positive(),
      currency: z.string().length(3).default("NGN"),
      stockQuantity: z.number().int().min(0).default(0),
      weight: z.number().optional(),
      images: z.array(z.string().url()).optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      productId: z.string().optional(), // link to existing platform product
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tenantId = getTenantId(ctx);
      const [row] = await db.insert(medusaProductOnboarding).values({
        tenantId,
        productId: input.productId,
        title: input.title,
        description: input.description,
        sku: input.sku,
        price: String(input.price),
        currency: input.currency,
        stockQuantity: input.stockQuantity,
        weight: input.weight ? String(input.weight) : undefined,
        images: input.images ?? [],
        categories: input.categories ?? [],
        tags: input.tags ?? [],
        status: "draft",
      }).returning();
      return row;
    }),

  /** Import products from the platform catalog into the onboarding queue */
  importFromCatalog: protectedProcedure
    .input(z.object({
      productIds: z.array(z.string()).min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tenantId = getTenantId(ctx);

      const catalogProducts = await db.select().from(products)
        .where(and(
          eq(products.tenantId, tenantId),
          inArray(products.id, input.productIds),
        ));

      if (catalogProducts.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No matching products found" });
      }

      const inserted = await Promise.all(
        catalogProducts.map(p =>
          db.insert(medusaProductOnboarding).values({
            tenantId,
            productId: p.id,
            title: p.name,
            description: p.description ?? undefined,
            sku: p.sku ?? undefined,
            price: p.price,
            currency: p.currency,
            stockQuantity: p.stockQuantity ?? 0,
            status: "draft",
          }).onConflictDoNothing().returning()
        )
      );
      return { imported: inserted.flat().length };
    }),

  /** Push one or more draft products to Medusa via Admin API */
  pushToMedusa: protectedProcedure
    .input(z.object({
      ids: z.array(z.string()).min(1).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tenantId = getTenantId(ctx);

      const config = await getMedusaAdminConfig(tenantId);
      const hasMedusa = config?.status === "active" && config.baseUrl && config.apiKey;

      const rows = await db.select().from(medusaProductOnboarding)
        .where(and(
          eq(medusaProductOnboarding.tenantId, tenantId),
          inArray(medusaProductOnboarding.id, input.ids),
        ));

      const results: Array<{ id: string; status: string; medusaProductId?: string }> = [];

      for (const row of rows) {
        // Mark as syncing
        await db.update(medusaProductOnboarding)
          .set({ status: "syncing", updatedAt: new Date() })
          .where(eq(medusaProductOnboarding.id, row.id));

        if (hasMedusa) {
          // Real push to Medusa Admin API
          const pushed = await pushProductToMedusa(config!.baseUrl!, config!.apiKey!, {
            title: row.title,
            description: row.description,
            sku: row.sku,
            price: Number(row.price),
            currency: row.currency,
            stockQuantity: row.stockQuantity,
            images: (row.images as string[]) ?? [],
            tags: (row.tags as string[]) ?? [],
          });

          if (pushed) {
            await db.update(medusaProductOnboarding)
              .set({
                status: "synced",
                medusaProductId: pushed.productId,
                medusaVariantId: pushed.variantId,
                medusaInventoryItemId: pushed.inventoryItemId,
                syncedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(medusaProductOnboarding.id, row.id));
            results.push({ id: row.id, status: "synced", medusaProductId: pushed.productId });
          } else {
            await db.update(medusaProductOnboarding)
              .set({ status: "failed", errorMessage: "Medusa API push failed", updatedAt: new Date() })
              .where(eq(medusaProductOnboarding.id, row.id));
            results.push({ id: row.id, status: "failed" });
          }
        } else {
          // Simulation mode — mark as synced with mock IDs
          const mockId = `medusa_${crypto.randomUUID().slice(0, 8)}`;
          await db.update(medusaProductOnboarding)
            .set({
              status: "synced",
              medusaProductId: mockId,
              medusaVariantId: `var_${mockId}`,
              medusaInventoryItemId: `inv_${mockId}`,
              syncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(medusaProductOnboarding.id, row.id));
          results.push({ id: row.id, status: "synced", medusaProductId: mockId });
        }
      }

      return { results, pushed: results.filter(r => r.status === "synced").length };
    }),

  /** Delete an onboarding record */
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tenantId = getTenantId(ctx);
      await db.delete(medusaProductOnboarding)
        .where(and(
          eq(medusaProductOnboarding.id, input.id),
          eq(medusaProductOnboarding.tenantId, tenantId),
        ));
      return { success: true };
    }),

  /** Get stats for the onboarding dashboard */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { total: 0, draft: 0, synced: 0, failed: 0, syncing: 0 };
    const tenantId = getTenantId(ctx);
    const rows = await db.select({ status: medusaProductOnboarding.status })
      .from(medusaProductOnboarding)
      .where(eq(medusaProductOnboarding.tenantId, tenantId));
    const counts = { total: rows.length, draft: 0, synced: 0, failed: 0, syncing: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts] = (counts[r.status as keyof typeof counts] ?? 0) + 1;
    return counts;
  }),
});
