import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  inventorySnapshots, inventorySyncLog, products, odooSyncedProducts,
  stockAdjustments, // === W43 exchanges (Coder B) ===
} from "../../drizzle/schema";
import { eq, and, desc, sql, lt, lte } from "drizzle-orm";
import { randomUUID } from "crypto";
import { syncTenantInventoryFromOdoo } from "../services/inventorySync";

export const inventoryRouter = router({
  // ── Get stock levels for a tenant ──────────────────────────────────────────
  getStockLevels: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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
  getStockAlerts: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      // A3-F02: real Odoo data only — no fabricated reservations.
      const result = await syncTenantInventoryFromOdoo(db, input.tenantId);
      return { success: true, recordsSynced: result.recordsSynced, syncedReservations: result.syncedReservations };
    }),

  // ── Manual stock correction ─────────────────────────────────────────────────
  // QA follow-up: recordStockAdjustment (services/stockAdjustments.ts) is
  // "the SINGLE audit-write helper for every stock mutation on the
  // platform" per its own header, and its reason enum has "correction"/
  // "count" cases specifically for this — but nothing ever called it for a
  // manual entry. A merchant doing a physical stock count had no way to fix
  // a wrong number at all.
  adjustStock: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      newQuantity: z.number().int().min(0),
      reason: z.enum(["correction", "count", "damage", "theft", "other"]).default("correction"),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const { assertCapabilityAccess } = await import("../services/capabilities");
      await assertCapabilityAccess(ctx.user, input.tenantId, "catalog");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const { recordStockAdjustment } = await import("../services/stockAdjustments");

      const result = await db.transaction(async (tx) => {
        const [product] = await tx.select({ stockQuantity: products.stockQuantity })
          .from(products)
          .where(and(eq(products.id, input.productId), eq(products.tenantId, input.tenantId)))
          .limit(1);
        if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "Product not found" });

        const deltaQty = input.newQuantity - product.stockQuantity;
        if (deltaQty === 0) return { newQuantity: input.newQuantity, adjustmentId: null as string | null };

        await tx.update(products)
          .set({ stockQuantity: input.newQuantity })
          .where(and(eq(products.id, input.productId), eq(products.tenantId, input.tenantId)));

        // inventory_snapshots only exists for ERP-synced products (see
        // reserveStock above) — keep it in lockstep when present, or the
        // Stock Sync view's COALESCE(snapshot, products.stockQuantity)
        // would silently show the stale synced number instead.
        await tx.execute(sql`
          UPDATE inventory_snapshots
          SET "stockQty" = ${input.newQuantity},
              "availableQty" = GREATEST(${input.newQuantity} - "reservedQty", 0),
              "lastSyncedAt" = NOW()
          WHERE "tenantId" = ${input.tenantId} AND "productId" = ${input.productId}
        `);

        const adjustmentId = await recordStockAdjustment(tx, {
          tenantId: input.tenantId,
          productId: input.productId,
          deltaQty,
          reason: input.reason,
          refType: "manual",
          actorId: String(ctx.user.id),
          note: input.note ?? `Manual ${input.reason}: ${product.stockQuantity} → ${input.newQuantity}`,
        });
        return { newQuantity: input.newQuantity, adjustmentId };
      });
      return result;
    }),

  // ── Reserve stock (oversell guard) ─────────────────────────────────────────
  reserveStock: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      qty: z.number().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // inventory_snapshots only exists for ERP-synced products (Odoo/Medusa
      // sync services) — a missing row means this product's stock lives in
      // products.stockQuantity instead, which orderCrud.create's reserveStock()
      // guards atomically. Distinguish "not ERP-tracked" from "actually out of
      // stock" so callers don't get a misleading insufficient-stock error.
      const [snapshot] = await db.execute(sql`
        SELECT id FROM inventory_snapshots
        WHERE "tenantId" = ${input.tenantId} AND "productId" = ${input.productId}
        LIMIT 1
      `) as unknown[];
      if (!snapshot) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This product is not under ERP-managed inventory tracking. Local-inventory stock is reserved automatically when the order is created.",
        });
      }
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
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Insufficient stock for product ${input.productId}. Cannot reserve ${input.qty} units.`,
        });
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
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
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

  // === W43 exchanges (Coder B): stock-adjustment audit trail ────────────────
  // ── Adjustment history (append-only stock_adjustments, tenant-scoped) ─────
  adjustmentHistory: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string().optional(),
      reason: z.enum(["restock", "damage", "theft", "correction", "count", "backorder_fill", "exchange_in", "exchange_out", "other"]).optional(),
      refType: z.string().optional(),
      refId: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(stockAdjustments.tenantId, input.tenantId)];
      if (input.productId) conds.push(eq(stockAdjustments.productId, input.productId));
      if (input.reason) conds.push(eq(stockAdjustments.reason, input.reason));
      if (input.refType) conds.push(eq(stockAdjustments.refType, input.refType));
      if (input.refId) conds.push(eq(stockAdjustments.refId, input.refId));
      return db.select().from(stockAdjustments)
        .where(and(...conds))
        .orderBy(desc(stockAdjustments.createdAt))
        .limit(input.limit);
    }),
  // === END W43 exchanges ===

  // ── Sync history ───────────────────────────────────────────────────────────
  getSyncHistory: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().default(20) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(inventorySyncLog)
        .where(eq(inventorySyncLog.tenantId, input.tenantId))
        .orderBy(desc(inventorySyncLog.syncedAt))
        .limit(input.limit);
    }),
});
