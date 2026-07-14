/**
 * Heartbeat router — handles scheduled job callbacks from the Manus Heartbeat platform.
 * Routes are registered under /api/scheduled/* and called by the platform on schedule.
 * 
 * IMPORTANT: These endpoints only work after the site is Published (deployed).
 * The Heartbeat platform cannot reach the sandbox dev server.
 */
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { inventorySnapshots } from "../../drizzle/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const heartbeatRouter = router({
  /**
   * Inventory sync job — called every 5 minutes by the Heartbeat platform.
   * In production: calls Odoo XML-RPC to pull stock quantities.
   * Here: simulates a sync by updating timestamps and checking low-stock thresholds.
   */
  inventorySync: publicProcedure
    .input(z.object({ _heartbeat: z.string().optional() }).optional())
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // In production: call Odoo XML-RPC here
      // const odooStock = await callOdooXmlRpc(ENV.odooUrl, ENV.odooDb, ENV.odooUser, ENV.odooPassword);
      // For now: update lastSyncedAt for all snapshots to mark sync ran
      const now = Date.now();
      await db
        .update(inventorySnapshots)
        .set({ lastSyncedAt: new Date(now), syncSource: "heartbeat" })
        .execute();

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
        synced: true,
        syncedAt: new Date(now).toISOString(),
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
