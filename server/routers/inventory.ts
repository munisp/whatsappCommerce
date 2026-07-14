import { z } from "zod";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import {
  inventorySnapshots, inventorySyncLog, products, odooSyncedProducts,
} from "../../drizzle/schema";
import { eq, and, desc, sql, lt, lte } from "drizzle-orm";
import { randomUUID } from "crypto";

export const inventoryRouter = router({
  // ── Get stock levels for a tenant ──────────────────────────────────────────
  getStockLevels: publicProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      // Join inventory snapshots with products for full picture
      const rows = await db.execute(sql`
        SELECT
          p.id AS "productId",
          p.name AS "productName",
          p.sku,
          p.category,
          p."stockQuantity" AS "localStock",
          p."lowStockThreshold",
          COALESCE(s."stockQty", p."stockQuantity") AS "stockQty",
          COALESCE(s."reservedQty", 0) AS "reservedQty",
          COALESCE(s."availableQty", p."stockQuantity") AS "availableQty",
          s."lastSyncedAt",
          s."syncSource",
          CASE
            WHEN COALESCE(s."availableQty", p."stockQuantity") <= 0 THEN 'out_of_stock'
            WHEN COALESCE(s."availableQty", p."stockQuantity") <= p."lowStockThreshold" THEN 'low_stock'
            ELSE 'in_stock'
          END AS "stockStatus"
        FROM products p
        LEFT JOIN inventory_snapshots s ON s."productId" = p.id AND s."tenantId" = p."tenantId"
        WHERE p."tenantId" = ${input.tenantId}
        ORDER BY "stockStatus" DESC, p.name ASC
      `);
      return rows as any[];
    }),

  // ── Stock alert summary for dashboard ──────────────────────────────────────
  getStockAlerts: publicProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { outOfStock: 0, lowStock: 0, inStock: 0, lastSyncedAt: null };
      const rows = await db.execute(sql`
        SELECT
          COUNT(CASE WHEN COALESCE(s."availableQty", p."stockQuantity") <= 0 THEN 1 END) AS "outOfStock",
          COUNT(CASE WHEN COALESCE(s."availableQty", p."stockQuantity") > 0
                      AND COALESCE(s."availableQty", p."stockQuantity") <= p."lowStockThreshold" THEN 1 END) AS "lowStock",
          COUNT(CASE WHEN COALESCE(s."availableQty", p."stockQuantity") > p."lowStockThreshold" THEN 1 END) AS "inStock",
          MAX(s."lastSyncedAt") AS "lastSyncedAt"
        FROM products p
        LEFT JOIN inventory_snapshots s ON s."productId" = p.id AND s."tenantId" = p."tenantId"
        WHERE p."tenantId" = ${input.tenantId}
      `);
      const r = (rows as any[])[0];
      return {
        outOfStock: Number(r?.outOfStock ?? 0),
        lowStock: Number(r?.lowStock ?? 0),
        inStock: Number(r?.inStock ?? 0),
        lastSyncedAt: r?.lastSyncedAt ?? null,
      };
    }),

  // ── Sync from Odoo (simulated — real impl calls Odoo XML-RPC) ──────────────
  syncFromOdoo: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const logId = randomUUID();
      // Log sync start
      await db.insert(inventorySyncLog).values({
        id: logId,
        tenantId: input.tenantId,
        source: "odoo",
        status: "syncing",
        recordsSynced: 0,
        syncedAt: new Date(),
      });
      try {
        // Pull from odoo_synced_products (already synced from Odoo)
        const odooProds = await db.select().from(odooSyncedProducts)
          .where(eq(odooSyncedProducts.tenantId, input.tenantId));

        let synced = 0;
        for (const op of odooProds) {
          if (!op.localProductId) continue;
          const stockQty = Number(op.stockQty ?? 0);
          // Simulate reservations as 10% of stock
          const reservedQty = Math.floor(stockQty * 0.1);
          const availableQty = stockQty - reservedQty;
          await db.insert(inventorySnapshots).values({
            id: randomUUID(),
            tenantId: input.tenantId,
            productId: op.localProductId,
            odooProductId: op.odooId,
            stockQty: stockQty.toString(),
            reservedQty: reservedQty.toString(),
            availableQty: availableQty.toString(),
            lastSyncedAt: new Date(),
            syncSource: "odoo",
          }).onConflictDoUpdate({
            target: [inventorySnapshots.tenantId, inventorySnapshots.productId],
            set: {
              stockQty: stockQty.toString(),
              reservedQty: reservedQty.toString(),
              availableQty: availableQty.toString(),
              lastSyncedAt: new Date(),
            },
          });
          // Also update local product stock
          await db.update(products)
            .set({ stockQuantity: stockQty, updatedAt: new Date() })
            .where(eq(products.id, op.localProductId));
          synced++;
        }
        // Update log to success
        await db.update(inventorySyncLog)
          .set({ status: "success", recordsSynced: synced, syncedAt: new Date() })
          .where(eq(inventorySyncLog.id, logId));
        return { success: true, recordsSynced: synced };
      } catch (err: any) {
        await db.update(inventorySyncLog)
          .set({ status: "failed", errors: err.message, syncedAt: new Date() })
          .where(eq(inventorySyncLog.id, logId));
        throw err;
      }
    }),

  // ── Reserve stock (oversell guard) ─────────────────────────────────────────
  reserveStock: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      qty: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // Atomic check-and-reserve: only succeeds if availableQty >= requested qty
      const result = await db.execute(sql`
        UPDATE inventory_snapshots
        SET
          "reservedQty" = "reservedQty" + ${input.qty},
          "availableQty" = "availableQty" - ${input.qty},
          "lastSyncedAt" = NOW()
        WHERE "tenantId" = ${input.tenantId}
          AND "productId" = ${input.productId}
          AND "availableQty" >= ${input.qty}
        RETURNING id, "availableQty", "reservedQty"
      `);
      if ((result as any[]).length === 0) {
        throw new Error(`Insufficient stock for product ${input.productId}. Cannot reserve ${input.qty} units.`);
      }
      return { reserved: true, ...(result as any[])[0] };
    }),

  // ── Release reservation (on order cancel/failure) ──────────────────────────
  releaseReservation: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      qty: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.execute(sql`
        UPDATE inventory_snapshots
        SET
          "reservedQty" = GREATEST("reservedQty" - ${input.qty}, 0),
          "availableQty" = "availableQty" + ${input.qty},
          "lastSyncedAt" = NOW()
        WHERE "tenantId" = ${input.tenantId}
          AND "productId" = ${input.productId}
      `);
      return { released: true };
    }),

  // ── Sync history ───────────────────────────────────────────────────────────
  getSyncHistory: publicProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(20) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(inventorySyncLog)
        .where(eq(inventorySyncLog.tenantId, input.tenantId))
        .orderBy(desc(inventorySyncLog.syncedAt))
        .limit(input.limit);
    }),
});
