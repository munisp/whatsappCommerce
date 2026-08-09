/**
 * procurement.ts — tRPC router for B2B procurement.
 *
 *   Supplier profile CRUD  — own tenant only (assertTenantAccess)
 *   Directory + catalog    — any authenticated tenant (read-only)
 *   POs                    — list/detail for BOTH sides; approve/reject/fulfil
 *                            are supplier-side (assertTenantAccess against
 *                            po.supplierTenantId); cancel-draft is buyer-only.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  approvePurchaseOrder,
  cancelDraftPo,
  getPoById,
  getPoItems,
  getSupplierProfile,
  getWholesaleCatalog,
  handlePoPaymentConfirmed,
  listPos,
  listSuppliers,
  markPoFulfilled,
  rejectPurchaseOrder,
  submitPurchaseOrder,
  upsertSupplierProfile,
  PO_STATUSES,
  type DbHandle,
} from "../services/procurement";

async function requireDb(): Promise<DbHandle> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

const poStatusSchema = z.enum(PO_STATUSES);

/** Load a PO and assert the caller belongs to its BUYER or SUPPLIER tenant. */
async function getPoForEitherSide(
  db: DbHandle,
  user: { role: string; tenantId?: string | null },
  poId: string,
) {
  const po = await getPoById(db, poId);
  if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
  const isSide = (tenantId: string) => {
    try {
      assertTenantAccess(user, tenantId);
      return true;
    } catch {
      return false;
    }
  };
  if (!isSide(po.buyerTenantId) && !isSide(po.supplierTenantId)) {
    // Same message as NOT_FOUND: don't leak which side the caller failed.
    throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
  }
  return po;
}

export const procurementRouter = router({
  // ── Supplier profile (own tenant only) ────────────────────────────────────
  getMySupplierProfile: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return getSupplierProfile(db, input.tenantId);
    }),

  upsertSupplierProfile: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      moqCents: z.number().int().min(0).optional(),
      leadTimeDays: z.number().int().min(0).optional(),
      termsOffered: z.array(z.number().int().min(1)).optional(),
      defaultTermsDays: z.number().int().min(1).optional(),
      autoApproveBelowCents: z.number().int().min(0).nullable().optional(),
      categories: z.array(z.string().trim().min(1)).optional(),
      status: z.enum(["active", "paused"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return upsertSupplierProfile(db, input);
    }),

  // ── Directory + wholesale catalog (read-only, any tenant) ────────────────
  listSuppliers: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return listSuppliers(db, { buyerTenantId: input.tenantId, category: input.category, limit: input.limit });
    }),

  getWholesaleCatalog: protectedProcedure
    .input(z.object({ tenantId: z.string(), supplierTenantId: z.string(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const catalog = await getWholesaleCatalog(db, { supplierTenantId: input.supplierTenantId, limit: input.limit });
      if (!catalog) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not available for procurement" });
      return catalog;
    }),

  // ── Purchase orders ───────────────────────────────────────────────────────
  createPo: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string(),
      supplierTenantId: z.string(),
      buyerPhone: z.string().max(30).optional(),
      paymentMode: z.enum(["credit", "paynow"]).default("credit"),
      termsDays: z.number().int().min(1).optional(),
      notes: z.string().max(2000).optional(),
      lines: z.array(z.object({
        productRef: z.string().max(128).optional(),
        name: z.string().trim().min(1).max(255),
        qty: z.number().int().positive(),
        unitPriceCents: z.number().int().min(0),
      })).min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const result = await submitPurchaseOrder(db, {
        buyerTenantId: input.buyerTenantId,
        supplierTenantId: input.supplierTenantId,
        buyerPhone: input.buyerPhone ?? null,
        lines: input.lines,
        paymentMode: input.paymentMode,
        termsDays: input.termsDays ?? null,
        notes: input.notes ?? null,
      });
      if (!result.ok) {
        const msg = result.reason === "below_moq"
          ? `Subtotal below supplier MOQ of ${result.moqCents} cents`
          : result.reason === "empty"
            ? "PO has no valid lines"
            : "Supplier is not available for procurement";
        throw new TRPCError({ code: "BAD_REQUEST", message: msg });
      }
      return { po: result.po, autoApproved: result.autoApproved ?? false };
    }),

  listPos: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      role: z.enum(["buyer", "supplier"]),
      status: poStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      return listPos(db, { tenantId: input.tenantId, role: input.role, status: input.status, limit: input.limit });
    }),

  getPo: protectedProcedure
    .input(z.object({ poId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      const po = await getPoForEitherSide(db, ctx.user, input.poId);
      const items = await getPoItems(db, po.id);
      return { po, items };
    }),

  approvePo: protectedProcedure
    .input(z.object({ poId: z.string(), termsDays: z.number().int().min(1).optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const po = await getPoById(db, input.poId);
      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
      assertTenantAccess(ctx.user, po.supplierTenantId); // supplier-side only
      const result = await approvePurchaseOrder(db, { poId: input.poId, termsDays: input.termsDays });
      if (!result.ok) {
        if (result.reason === "wrong_status") {
          throw new TRPCError({ code: "CONFLICT", message: `PO is ${po.status}, expected submitted` });
        }
        if (result.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
        // Credit guard failures are a normal business outcome, not an error.
        return { approved: false as const, creditFailure: result.reason };
      }
      return { approved: true as const, result };
    }),

  rejectPo: protectedProcedure
    .input(z.object({ poId: z.string(), reason: z.string().max(1000).optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const po = await getPoById(db, input.poId);
      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
      assertTenantAccess(ctx.user, po.supplierTenantId); // supplier-side only
      const result = await rejectPurchaseOrder(db, { poId: input.poId, reason: input.reason ?? null });
      if (!result.ok) throw new TRPCError({ code: "CONFLICT", message: `PO is ${po.status}, expected submitted` });
      return { rejected: true as const };
    }),

  markFulfilled: protectedProcedure
    .input(z.object({ poId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const po = await getPoById(db, input.poId);
      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
      assertTenantAccess(ctx.user, po.supplierTenantId); // supplier-side only
      const result = await markPoFulfilled(db, { poId: input.poId });
      if (!result.ok) throw new TRPCError({ code: "CONFLICT", message: `PO is ${po.status} and cannot be fulfilled` });
      return { fulfilled: true as const };
    }),

  /** Manual payment confirmation for paynow POs (supplier confirms receipt). */
  markPaid: protectedProcedure
    .input(z.object({ poId: z.string(), reference: z.string().max(128).optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const po = await getPoById(db, input.poId);
      if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found" });
      assertTenantAccess(ctx.user, po.supplierTenantId); // supplier-side only
      const result = await handlePoPaymentConfirmed(db, { poId: input.poId, reference: input.reference });
      if (!result.ok) throw new TRPCError({ code: "CONFLICT", message: `PO payment could not be confirmed (${result.action})` });
      return { paid: true as const, action: result.action };
    }),

  cancelDraftPo: protectedProcedure
    .input(z.object({ poId: z.string(), buyerTenantId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId); // buyer-side only
      const db = await requireDb();
      const result = await cancelDraftPo(db, { poId: input.poId, buyerTenantId: input.buyerTenantId });
      if (!result.ok) {
        const code = result.reason === "wrong_status" ? "CONFLICT" : result.reason === "forbidden" ? "FORBIDDEN" : "NOT_FOUND";
        throw new TRPCError({ code, message: `Draft PO could not be cancelled (${result.reason})` });
      }
      return { cancelled: true as const };
    }),
});
