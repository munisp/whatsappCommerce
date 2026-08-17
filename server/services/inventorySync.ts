/**
 * A3-F02/F03: real inventory sync service.
 *
 * Replaces the fabricated-reservations stub: stock quantities come from real
 * Odoo-synced data (`odoo_synced_products`) only. Reservations are NOT
 * fabricated — `reservedQty` is 0 until a real reservation source exists, and
 * every result carries `syncedReservations: false` so callers/UI can be
 * honest about it.
 *
 * `runInventorySyncHeartbeat` is the cron/heartbeat entry point: it syncs
 * every tenant that has Odoo-synced products, logs per-tenant failures, and
 * never throws (fail-closed logging).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getDb } from "../db";
import {
  inventorySnapshots,
  inventorySyncLog,
  odooSyncedProducts,
  products,
} from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface TenantSyncResult {
  tenantId: string;
  recordsSynced: number;
  /** Reservations are never fabricated by this sync. */
  syncedReservations: false;
}

export async function syncTenantInventoryFromOdoo(
  db: Db,
  tenantId: string,
): Promise<TenantSyncResult> {
  const logId = randomUUID();
  await db.insert(inventorySyncLog).values({
    id: logId,
    tenantId,
    source: "odoo",
    status: "syncing",
    recordsSynced: 0,
    syncedAt: new Date(),
  });
  try {
    // Pull from odoo_synced_products (real data already synced from Odoo).
    const odooProds = await db
      .select()
      .from(odooSyncedProducts)
      .where(eq(odooSyncedProducts.tenantId, tenantId));

    let synced = 0;
    for (const op of odooProds) {
      if (!op.localProductId) continue;
      const stockQty = Number(op.stockQty ?? 0);
      // Real data only: no fabricated reservations.
      const reservedQty = 0;
      const availableQty = stockQty - reservedQty;
      await db
        .insert(inventorySnapshots)
        .values({
          id: randomUUID(),
          tenantId,
          productId: op.localProductId,
          odooProductId: op.odooId,
          stockQty: stockQty.toString(),
          reservedQty: reservedQty.toString(),
          availableQty: availableQty.toString(),
          lastSyncedAt: new Date(),
          syncSource: "odoo",
        })
        .onConflictDoUpdate({
          target: [inventorySnapshots.tenantId, inventorySnapshots.productId],
          set: {
            stockQty: stockQty.toString(),
            reservedQty: reservedQty.toString(),
            availableQty: availableQty.toString(),
            lastSyncedAt: new Date(),
          },
        });
      // Also update local product stock.
      await db
        .update(products)
        .set({ stockQuantity: stockQty, updatedAt: new Date() })
        .where(eq(products.id, op.localProductId));
      synced++;
    }
    await db
      .update(inventorySyncLog)
      .set({ status: "success", recordsSynced: synced, syncedAt: new Date() })
      .where(eq(inventorySyncLog.id, logId));
    return { tenantId, recordsSynced: synced, syncedReservations: false };
  } catch (err: any) {
    await db
      .update(inventorySyncLog)
      .set({ status: "failed", errors: err?.message ?? String(err), syncedAt: new Date() })
      .where(eq(inventorySyncLog.id, logId));
    throw err;
  }
}

export interface HeartbeatSyncSummary {
  tenants: number;
  succeeded: number;
  failed: string[];
  recordsSynced: number;
  syncedReservations: false;
  syncedAt: string;
}

/**
 * Heartbeat entry point (A3-F03): runs the real sync for every tenant with
 * Odoo-synced products. Fail-closed logging — per-tenant errors are logged
 * and collected, never thrown.
 */
export async function runInventorySyncHeartbeat(): Promise<HeartbeatSyncSummary> {
  const db = await getDb();
  if (!db) {
    console.error("[inventorySyncHeartbeat] DB unavailable");
    return {
      tenants: 0,
      succeeded: 0,
      failed: ["db-unavailable"],
      recordsSynced: 0,
      syncedReservations: false,
      syncedAt: new Date().toISOString(),
    };
  }
  const tenantRows = await db
    .selectDistinct({ tenantId: odooSyncedProducts.tenantId })
    .from(odooSyncedProducts);
  const tenantIds = Array.from(new Set(tenantRows.map((r) => r.tenantId)));

  const failed: string[] = [];
  let recordsSynced = 0;
  let succeeded = 0;
  for (const tenantId of tenantIds) {
    try {
      const res = await syncTenantInventoryFromOdoo(db, tenantId);
      recordsSynced += res.recordsSynced;
      succeeded++;
    } catch (err: any) {
      console.error(`[inventorySyncHeartbeat] tenant ${tenantId} failed:`, err?.message ?? err);
      failed.push(tenantId);
    }
  }
  return {
    tenants: tenantIds.length,
    succeeded,
    failed,
    recordsSynced,
    syncedReservations: false,
    syncedAt: new Date().toISOString(),
  };
}
