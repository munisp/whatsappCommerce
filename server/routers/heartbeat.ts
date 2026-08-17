/**
 * Heartbeat router — handles scheduled job callbacks from the Manus Heartbeat platform.
 * Routes are registered under /api/scheduled/* and called by the platform on schedule.
 * 
 * IMPORTANT: These endpoints only work after the site is Published (deployed).
 * The Heartbeat platform cannot reach the sandbox dev server.
 */
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { runInventorySyncHeartbeat } from "../services/inventorySync";
import { inventorySnapshots } from "../../drizzle/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";

export { runInventorySyncHeartbeat } from "../services/inventorySync";

export const heartbeatRouter = router({
  /**
   * Inventory sync job — called every 5 minutes by the Heartbeat platform.
   * In production: calls Odoo XML-RPC to pull stock quantities.
   * Here: simulates a sync by updating timestamps and checking low-stock thresholds.
   */
  inventorySync: publicProcedure
    .input(z.object({ _heartbeat: z.string().optional() }).optional())
    .mutation(async ({ ctx }) => {
      // A3-F03: run the real per-tenant Odoo inventory sync (fail-closed
      // logging inside; never throws), then report low-stock items.
      const summary = await runInventorySyncHeartbeat();

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Find low-stock items
      const lowStockItems = await db
        .select({
          id: inventorySnapshots.id,
          productId: inventorySnapshots.productId,
          availableQty: inventorySnapshots.availableQty,
        })
        .from(inventorySnapshots)
        .where(
          sql`CAST(${inventorySnapshots.availableQty} AS NUMERIC) < 10`
        )
        .execute();

      return {
        ...summary,
        synced: summary.failed.length === 0,
        lowStockCount: lowStockItems.length,
        lowStockItems: lowStockItems.map((i: { productId: string; availableQty: string }) => ({
          productId: i.productId,
          availableQty: i.availableQty,
        })),
      };
    }),
});

/**
 * Heartbeat job registration — call this once after deployment to register the schedule.
 * Run from a one-off script or admin endpoint:
 *   POST /api/trpc/heartbeat.inventorySync
 * 
 * Job definition (register via heartbeat SDK):
 * {
 *   name: "inventory-sync",
 *   cron: "0 *\/5 * * * *",   // every 5 minutes
 *   path: "/api/scheduled/inventory-sync",
 *   method: "POST",
 *   description: "Sync inventory from Odoo ERP and check low-stock thresholds"
 * }
 */
