/**
 * Odoo ↔ Medusa Inventory Bridge Router
 *
 * Architecture:
 *   Odoo is the SOURCE OF TRUTH for stock levels (warehouse management).
 *   Medusa is the COMMERCE LAYER (storefront, cart, checkout).
 *
 * Sync flow:
 *   1. Pull stock quants from Odoo via XML-RPC / JSON-RPC API
 *   2. Map Odoo product.product IDs → Medusa inventory item IDs (via bridge table)
 *   3. Push updated stock levels to Medusa Admin API
 *   4. Record sync results in odoo_medusa_inventory_bridge table
 *
 * Bidirectional:
 *   - Odoo → Medusa: stock adjustments, warehouse receipts, deliveries
 *   - Medusa → Odoo: confirmed orders (sale.order creation, already done in NLP flow)
 */
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  odooMedusaInventoryBridge,
} from "../../drizzle/schema";
import {
  getMedusaIntegrationConfig,
  getOdooIntegrationConfig,
  odooAuthenticate,
  odooExecuteKw,
} from "../services/integrationSync";

function getTenantId(ctx: { user: { tenantId?: string | null } }): string {
  return ctx.user?.tenantId ?? "default";
}

/**
 * Bridge mutations write inventory mappings and push stock levels to external
 * systems, so they are restricted to platform admins and members of the
 * tenant (the procedures always operate on the caller's own tenant; this
 * blocks the anonymous "default" fallback for non-admins).
 */
function assertBridgeAccess(ctx: { user: { role: string; tenantId?: string | null } }) {
  if (ctx.user.role === "admin") return;
  if (!ctx.user.tenantId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only tenant members or admins can manage the Odoo↔Medusa bridge",
    });
  }
}

// ── Integration config helpers ────────────────────────────────────────────────
// Odoo credentials come from odoo_integrations (the single source of truth,
// shared with odoo.ts / integrationSync.ts); Medusa credentials come from
// tenant_integrations ("medusa") with the MEDUSA_* env vars as bootstrap
// fallback.  Both resolvers live in services/integrationSync.ts.
const getOdooConfig = getOdooIntegrationConfig;
const getMedusaConfig = getMedusaIntegrationConfig;

// ── Odoo stock fetch (JSON-RPC) ───────────────────────────────────────────────
async function fetchOdooStockQuants(
  cfg: { baseUrl: string; database: string; username: string; apiKey: string },
): Promise<Array<{ odooProductId: string; productName: string; sku: string; qty: number; reservedQty: number; warehouse: string }>> {
  try {
    const uid = await odooAuthenticate(cfg);
    const rows = await odooExecuteKw(
      cfg,
      uid,
      "stock.quant",
      "search_read",
      [[["location_id.usage", "=", "internal"]]],
      {
        fields: ["product_id", "quantity", "reserved_quantity", "location_id"],
        limit: 500,
        context: { lang: "en_US", uid, active_test: true },
      },
    );
    return (Array.isArray(rows) ? rows : []).map((q: any) => ({
      odooProductId: String(q.product_id?.[0] ?? ""),
      productName: q.product_id?.[1] ?? "Unknown",
      sku: "",
      qty: q.quantity ?? 0,
      reservedQty: q.reserved_quantity ?? 0,
      warehouse: q.location_id?.[1] ?? "default",
    }));
  } catch (err: any) {
    console.error("[OdooMedusaBridge] fetchOdooStockQuants failed:", err?.message ?? err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ── Medusa inventory level update ─────────────────────────────────────────────
async function updateMedusaInventoryLevel(
  baseUrl: string,
  apiKey: string,
  inventoryItemId: string,
  stockedQty: number,
): Promise<boolean> {
  try {
    const base = baseUrl.replace(/\/$/, "");
    // Get existing location levels
    const levelsRes = await fetch(`${base}/admin/inventory-items/${inventoryItemId}/location-levels`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!levelsRes.ok) {
      const body = await levelsRes.text().catch(() => "");
      throw new Error(`Medusa location-levels fetch failed (${levelsRes.status}): ${body.slice(0, 300)}`);
    }
    const { inventory_levels } = await levelsRes.json() as { inventory_levels?: Array<{ id: string; location_id: string }> };
    const locationId = inventory_levels?.[0]?.location_id ?? "default";

    // Update stock level
    const updateRes = await fetch(
      `${base}/admin/inventory-items/${inventoryItemId}/location-levels/${locationId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ stocked_quantity: stockedQty }),
      },
    );
    if (!updateRes.ok) {
      const body = await updateRes.text().catch(() => "");
      throw new Error(`Medusa stock update failed (${updateRes.status}): ${body.slice(0, 300)}`);
    }
    return true;
  } catch (err: any) {
    console.error("[OdooMedusaBridge] updateMedusaInventoryLevel failed:", err?.message ?? err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export const odooMedusaBridgeRouter = router({
  /** List all bridge mappings for this tenant */
  list: protectedProcedure
    .input(z.object({
      syncStatus: z.enum(["pending", "syncing", "synced", "conflict", "failed"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };
      const tenantId = getTenantId(ctx);
      const rows = await db.select().from(odooMedusaInventoryBridge)
        .where(
          input?.syncStatus
            ? and(eq(odooMedusaInventoryBridge.tenantId, tenantId), eq(odooMedusaInventoryBridge.syncStatus, input.syncStatus))
            : eq(odooMedusaInventoryBridge.tenantId, tenantId)
        )
        .orderBy(desc(odooMedusaInventoryBridge.updatedAt))
        .limit(200);
      return { items: rows, total: rows.length };
    }),

  /** Create or update a bridge mapping between an Odoo product and a Medusa variant */
  upsertMapping: protectedProcedure
    .input(z.object({
      odooProductId: z.string(),
      odooProductName: z.string().optional(),
      odooSku: z.string().optional(),
      medusaProductId: z.string().optional(),
      medusaVariantId: z.string().optional(),
      medusaInventoryItemId: z.string().optional(),
      syncDirection: z.enum(["odoo_to_medusa", "medusa_to_odoo", "bidirectional"]).default("odoo_to_medusa"),
    }))
    .mutation(async ({ ctx, input }) => {
      assertBridgeAccess(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tenantId = getTenantId(ctx);

      // Check for existing mapping
      const [existing] = await db.select().from(odooMedusaInventoryBridge)
        .where(and(
          eq(odooMedusaInventoryBridge.tenantId, tenantId),
          eq(odooMedusaInventoryBridge.odooProductId, input.odooProductId),
        ))
        .limit(1);

      if (existing) {
        const [updated] = await db.update(odooMedusaInventoryBridge)
          .set({
            odooProductName: input.odooProductName,
            odooSku: input.odooSku,
            medusaProductId: input.medusaProductId,
            medusaVariantId: input.medusaVariantId,
            medusaInventoryItemId: input.medusaInventoryItemId,
            syncDirection: input.syncDirection,
            updatedAt: new Date(),
          })
          .where(eq(odooMedusaInventoryBridge.id, existing.id))
          .returning();
        return updated;
      }

      const [created] = await db.insert(odooMedusaInventoryBridge).values({
        tenantId,
        odooProductId: input.odooProductId,
        odooProductName: input.odooProductName,
        odooSku: input.odooSku,
        medusaProductId: input.medusaProductId,
        medusaVariantId: input.medusaVariantId,
        medusaInventoryItemId: input.medusaInventoryItemId,
        syncDirection: input.syncDirection,
        syncStatus: "pending",
      }).returning();
      return created;
    }),

  /**
   * Run Odoo → Medusa inventory sync
   * 1. Fetch stock quants from Odoo
   * 2. For each quant with a bridge mapping, push updated qty to Medusa
   * 3. Record results
   */
  syncOdooToMedusa: protectedProcedure.mutation(async ({ ctx }) => {
    assertBridgeAccess(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const tenantId = getTenantId(ctx);

    const [odooConfig, medusaConfig] = await Promise.all([
      getOdooConfig(tenantId),
      getMedusaConfig(tenantId),
    ]);

    const hasOdoo = !!(odooConfig?.baseUrl && odooConfig?.apiKey);
    const hasMedusa = !!(medusaConfig?.baseUrl && medusaConfig?.adminApiKey);

    // Get all bridge mappings for this tenant
    const mappings = await db.select().from(odooMedusaInventoryBridge)
      .where(eq(odooMedusaInventoryBridge.tenantId, tenantId));

    if (mappings.length === 0) {
      return { synced: 0, failed: 0, message: "No bridge mappings configured" };
    }

    let synced = 0;
    let failed = 0;

    if (hasOdoo) {
      // Fetch real Odoo stock
      const quants = await fetchOdooStockQuants(odooConfig!);

      for (const mapping of mappings) {
        const quant = quants.find(q => q.odooProductId === mapping.odooProductId);
        if (!quant) continue;

        const availableQty = Math.max(0, quant.qty - quant.reservedQty);

        // Update bridge record with latest Odoo stock
        await db.update(odooMedusaInventoryBridge)
          .set({
            odooStockQty: String(quant.qty),
            odooReservedQty: String(quant.reservedQty),
            odooWarehouse: quant.warehouse,
            syncStatus: "syncing",
            lastOdooUpdate: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(odooMedusaInventoryBridge.id, mapping.id));

        // Push to Medusa if we have a mapping
        if (mapping.medusaInventoryItemId && hasMedusa) {
          const ok = await updateMedusaInventoryLevel(
            medusaConfig!.baseUrl,
            medusaConfig!.adminApiKey!,
            mapping.medusaInventoryItemId,
            availableQty,
          );
          await db.update(odooMedusaInventoryBridge)
            .set({
              medusaStockableQty: availableQty,
              syncStatus: ok ? "synced" : "failed",
              lastSyncedAt: ok ? new Date() : undefined,
              lastMedusaUpdate: ok ? new Date() : undefined,
              updatedAt: new Date(),
            })
            .where(eq(odooMedusaInventoryBridge.id, mapping.id));
          if (ok) synced++; else failed++;
        } else {
          // No Medusa mapping/config: record the real Odoo stock but keep the
          // mapping pending — it has NOT been pushed to Medusa.
          await db.update(odooMedusaInventoryBridge)
            .set({
              medusaStockableQty: availableQty,
              syncStatus: "pending",
              updatedAt: new Date(),
            })
            .where(eq(odooMedusaInventoryBridge.id, mapping.id));
        }
      }
    } else {
      // Odoo is unreachable or unconfigured: return a structured error status
      // and DO NOT write any inventory quantities to the database.
      const reason = !odooConfig
        ? "NOT_CONFIGURED: Odoo integration is not configured for this tenant (odoo_integrations)"
        : "Odoo integration is missing baseUrl or apiKey";
      console.warn(`[OdooMedusaBridge] syncOdooToMedusa aborted: ${reason}`);
      return {
        synced: 0,
        failed: 0,
        total: mappings.length,
        status: "odoo_unavailable" as const,
        error: reason,
      };
    }

    return { synced, failed, total: mappings.length, status: "ok" as const, error: null };
  }),

  /** Return a log of the last N sync events (derived from bridge records with lastSyncedAt) */
  listSyncHistory: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];
      const tenantId = getTenantId(ctx);
      // Return bridge records ordered by lastSyncedAt descending — each row is a sync event
      const rows = await db
        .select({
          id: odooMedusaInventoryBridge.id,
          odooProductName: odooMedusaInventoryBridge.odooProductName,
          odooProductId: odooMedusaInventoryBridge.odooProductId,
          odooStockQty: odooMedusaInventoryBridge.odooStockQty,
          medusaStockableQty: odooMedusaInventoryBridge.medusaStockableQty,
          syncStatus: odooMedusaInventoryBridge.syncStatus,
          syncDirection: odooMedusaInventoryBridge.syncDirection,
          lastSyncedAt: odooMedusaInventoryBridge.lastSyncedAt,
          conflictReason: odooMedusaInventoryBridge.conflictReason,
        })
        .from(odooMedusaInventoryBridge)
        .where(
          and(
            eq(odooMedusaInventoryBridge.tenantId, tenantId),
            sql`${odooMedusaInventoryBridge.lastSyncedAt} IS NOT NULL`,
          ),
        )
        .orderBy(desc(odooMedusaInventoryBridge.lastSyncedAt))
        .limit(30);
      return rows;
    }),

  /** Get sync summary stats */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { total: 0, synced: 0, pending: 0, failed: 0, conflict: 0 };
    const tenantId = getTenantId(ctx);
    const rows = await db.select({ syncStatus: odooMedusaInventoryBridge.syncStatus })
      .from(odooMedusaInventoryBridge)
      .where(eq(odooMedusaInventoryBridge.tenantId, tenantId));
    const counts = { total: rows.length, synced: 0, pending: 0, failed: 0, conflict: 0, syncing: 0 };
    for (const r of rows) {
      const k = r.syncStatus as keyof typeof counts;
      if (k in counts) counts[k]++;
    }
    return counts;
  }),
});
