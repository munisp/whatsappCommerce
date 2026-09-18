// === W46 inventory-depth ===
/**
 * inventoryDepth router — ORD-15 (barcode scan + variants), ORD-16
 * (warehouses + allocation), ORD-20 (delivery claims), ORD-21 (batches,
 * FEFO, expiry sweep). Tenant-scoped; state mutations gate on
 * assertTenantActive. All stock mutations audit via recordStockAdjustment
 * (see services/inventoryDepth.ts).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  deliveryClaims,
  inventoryBatches,
  productVariants,
  warehouseStock,
  warehouses,
  DELIVERY_CLAIM_TYPES,
  DELIVERY_CLAIM_STATUSES,
} from "../../drizzle/schema";
import { assertTenantActive, getTenantStatus } from "../services/tenantGuard";
import * as depth from "../services/inventoryDepth";

async function assertActive(db: any, tenantId: string) {
  const status = await getTenantStatus(db, tenantId);
  if (status) assertTenantActive({ id: tenantId, status: status as any });
}

export const inventoryDepthRouter = router({
  // ── ORD-15: barcode scan → product and/or variant ────────────────────────
  scanBarcode: protectedProcedure
    .input(z.object({ tenantId: z.string(), barcode: z.string().min(1).max(64) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const hit = await depth.scanBarcode(db, input.tenantId, input.barcode);
      if (!hit.product && !hit.variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No product or variant with barcode ${input.barcode}` });
      }
      return hit;
    }),

  // ── ORD-15: variant CRUD + stock receipt ─────────────────────────────────
  upsertVariant: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      sku: z.string().min(1).max(100),
      name: z.string().max(255).optional(),
      attributes: z.record(z.string(), z.any()).optional(),
      barcode: z.string().max(64).optional(),
      initialStock: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      const id = randomUUID();
      await db.insert(productVariants).values({
        id,
        tenantId: input.tenantId,
        productId: input.productId,
        sku: input.sku,
        name: input.name ?? null,
        attributes: input.attributes ?? null,
        barcode: input.barcode ?? null,
        stockQuantity: 0,
      });
      if (input.initialStock > 0) {
        // Initial stock flows through the audited receipt path so the parent
        // product total and the stock_adjustments trail stay consistent.
        await depth.receiveVariantStock(db, {
          tenantId: input.tenantId,
          variantId: id,
          qty: input.initialStock,
          actorId: String(ctx.user?.id ?? "") || null,
        });
      }
      return { id };
    }),

  listVariants: protectedProcedure
    .input(z.object({ tenantId: z.string(), productId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(productVariants.tenantId, input.tenantId)];
      if (input.productId) conds.push(eq(productVariants.productId, input.productId));
      return db.select().from(productVariants).where(and(...conds));
    }),

  receiveVariantStock: protectedProcedure
    .input(z.object({ tenantId: z.string(), variantId: z.string(), qty: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      await depth.receiveVariantStock(db, { ...input, actorId: String(ctx.user?.id ?? "") || null });
      return { ok: true };
    }),

  // ── ORD-16: warehouses ───────────────────────────────────────────────────
  createWarehouse: protectedProcedure
    .input(z.object({ tenantId: z.string(), name: z.string().min(1).max(255), isDefault: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      const id = randomUUID();
      await db.insert(warehouses).values({ id, tenantId: input.tenantId, name: input.name, isDefault: input.isDefault });
      return { id };
    }),

  listWarehouses: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      return db.select().from(warehouses).where(eq(warehouses.tenantId, input.tenantId));
    }),

  listWarehouseStock: protectedProcedure
    .input(z.object({ tenantId: z.string(), productId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(warehouseStock.tenantId, input.tenantId)];
      if (input.productId) conds.push(eq(warehouseStock.productId, input.productId));
      return db.select().from(warehouseStock).where(and(...conds));
    }),

  // ── ORD-21: batch receipt, listing, expiry sweep ─────────────────────────
  receiveBatch: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string(),
      qty: z.number().int().positive(),
      batchCode: z.string().max(64).optional(),
      expiryDate: z.coerce.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      const batchId = await depth.receiveBatch(db, {
        tenantId: input.tenantId,
        productId: input.productId,
        qty: input.qty,
        batchCode: input.batchCode ?? null,
        expiryDate: input.expiryDate ?? null,
        actorId: String(ctx.user?.id ?? "") || null,
      });
      return { batchId };
    }),

  listBatches: protectedProcedure
    .input(z.object({ tenantId: z.string(), productId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(inventoryBatches.tenantId, input.tenantId)];
      if (input.productId) conds.push(eq(inventoryBatches.productId, input.productId));
      return db.select().from(inventoryBatches).where(and(...conds)).orderBy(inventoryBatches.expiryDate);
    }),

  /** Merchant-triggered expiry sweep (same logic as the cron route). */
  runExpirySweep: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      return depth.sweepExpiringBatches(db);
    }),

  // ── ORD-20: delivery claims ──────────────────────────────────────────────
  createClaim: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      shipmentId: z.string(),
      orderId: z.string().optional(),
      type: z.enum(DELIVERY_CLAIM_TYPES),
      photos: z.array(z.string().url()).max(10).default([]),
      description: z.string().max(4000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      const id = await depth.createDeliveryClaim(db, { ...input, reportedBy: String(ctx.user?.id ?? "") || null });
      return { id };
    }),

  transitionClaim: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      claimId: z.string(),
      to: z.enum(DELIVERY_CLAIM_STATUSES),
      resolution: z.enum(["refund", "replacement", "redelivery", "none"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await assertActive(db, input.tenantId);
      try {
        await depth.transitionDeliveryClaim(db, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          to: input.to,
          resolution: input.resolution ?? null,
          actorId: String(ctx.user?.id ?? "") || null,
        });
      } catch (e: any) {
        if (e?.name === "ClaimTransitionError") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        }
        throw e;
      }
      return { ok: true };
    }),

  listClaims: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      shipmentId: z.string().optional(),
      status: z.enum(DELIVERY_CLAIM_STATUSES).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return [];
      const conds = [eq(deliveryClaims.tenantId, input.tenantId)];
      if (input.shipmentId) conds.push(eq(deliveryClaims.shipmentId, input.shipmentId));
      if (input.status) conds.push(eq(deliveryClaims.status, input.status));
      return db.select().from(deliveryClaims).where(and(...conds)).orderBy(desc(deliveryClaims.createdAt)).limit(input.limit);
    }),
});
// === END W46 inventory-depth ===
