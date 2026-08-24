/**
 * W27 — B2B wholesale marketplace router.
 *
 * Tenant-guarded procedures manage listings/tiers and both sides of the
 * order book. Public procedures (browse/search + phone-buyer checkout) are
 * hardened per the tracking.ts exemplar: strict input validation, active
 * listings only, and PII-scrubbed responses (no tenant internals, no buyer
 * data beyond the caller's own order id).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import { getDb } from "../db";
import { wholesaleListings, wholesaleListingTiers, wholesaleOrders } from "../../drizzle/schema";
import {
  createWholesaleListingTx,
  setWholesaleListingStatusTx,
  replaceWholesaleTiersTx,
  getWholesaleListingTx,
  searchWholesaleListingsTx,
  placeWholesaleOrderTx,
  listWholesaleOrdersTx,
  updateWholesaleOrderStatusTx,
  computeTieredPrice,
} from "../services/wholesaleCatalog";
import { getMerchantScoreGuarded } from "../services/creditScoreClient";

const TierInput = z.object({
  minQty: z.number().int().positive(),
  maxQty: z.number().int().positive().nullish(),
  unitPriceCents: z.number().int().positive(),
});

const phoneSchema = z.string().regex(/^\+?\d{7,15}$/, "invalid phone");

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

/** Public, PII-scrubbed projection of an active listing. */
function publicListing(l: any, tiers: any[]) {
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    category: l.category,
    moq: l.moq,
    currency: l.currency,
    tiers: tiers.map((t) => ({ minQty: t.minQty, maxQty: t.maxQty, unitPriceCents: t.unitPriceCents })),
  };
}

export const wholesaleRouter = router({
  // ── Wholesaler: listing management (tenant-guarded) ─────────────────────
  createListing: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      category: z.string().max(120).optional(),
      productId: z.string().max(36).optional(),
      moq: z.number().int().positive().default(1),
      currency: z.string().max(8).default("NGN"),
      tiers: z.array(TierInput).max(20).default([]),
      activate: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const listing = await createWholesaleListingTx(db, {
        ...input,
        status: input.activate ? "active" : "draft",
      });
      const tiers = input.tiers.length
        ? await replaceWholesaleTiersTx(db, { tenantId: input.tenantId, listingId: listing.id, tiers: input.tiers })
        : [];
      return { listing, tiers };
    }),

  updateListing: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      listingId: z.string().uuid(),
      status: z.enum(["draft", "active", "paused"]).optional(),
      tiers: z.array(TierInput).max(20).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      let listing = null;
      if (input.status) {
        listing = await setWholesaleListingStatusTx(db, {
          tenantId: input.tenantId, listingId: input.listingId, status: input.status,
        });
        if (!listing) throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      } else {
        const found = await getWholesaleListingTx(db, input.listingId);
        if (!found || found.listing.tenantId !== input.tenantId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
        }
        listing = found.listing;
      }
      const tiers = input.tiers
        ? await replaceWholesaleTiersTx(db, { tenantId: input.tenantId, listingId: input.listingId, tiers: input.tiers })
        : await db.select().from(wholesaleListingTiers).where(eq(wholesaleListingTiers.listingId, input.listingId));
      return { listing, tiers };
    }),

  listMyListings: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), limit: z.number().int().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const rows = await db
        .select()
        .from(wholesaleListings)
        .where(eq(wholesaleListings.tenantId, input.tenantId))
        .orderBy(desc(wholesaleListings.createdAt))
        .limit(Math.min(input.limit, 200));
      const out = [];
      for (const l of rows) {
        const tiers = await db.select().from(wholesaleListingTiers).where(eq(wholesaleListingTiers.listingId, l.id));
        out.push({ listing: l, tiers });
      }
      return out;
    }),

  // ── Marketplace browse/search (hardened public) ─────────────────────────
  browseMarketplace: publicProcedure
    .input(z.object({
      query: z.string().max(120).optional(),
      category: z.string().max(120).optional(),
      tenantId: z.string().max(36).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const rows = await searchWholesaleListingsTx(db, input);
      return rows.map((r) => publicListing(r.listing, r.tiers));
    }),

  getListingPublic: publicProcedure
    .input(z.object({ listingId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const found = await getWholesaleListingTx(db, input.listingId);
      if (!found || found.listing.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      }
      return publicListing(found.listing, found.tiers);
    }),

  /** Price quote for a quantity — public, deterministic, no state change. */
  quote: publicProcedure
    .input(z.object({ listingId: z.string().uuid(), quantity: z.number().int().positive().max(1_000_000) }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const found = await getWholesaleListingTx(db, input.listingId);
      if (!found || found.listing.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Listing not found" });
      }
      const priced = computeTieredPrice(found.tiers, input.quantity, found.listing.moq);
      if (!priced.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Cannot quote: ${priced.reason}` });
      }
      return {
        quantity: input.quantity,
        unitPriceCents: priced.unitPriceCents,
        totalCents: priced.totalCents,
        currency: found.listing.currency,
      };
    }),

  // ── Order placement ─────────────────────────────────────────────────────
  /** Retailer-tenant checkout (tenant-guarded; pay_now or trade_credit). */
  placeOrder: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1), // buyer (retailer) tenant
      listingId: z.string().uuid(),
      quantity: z.number().int().positive().max(1_000_000),
      paymentMode: z.enum(["pay_now", "trade_credit"]).default("pay_now"),
      termsDays: z.number().int().min(0).max(365).optional(),
      notes: z.string().max(2000).optional(),
      idempotencyKey: z.string().uuid().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const r = await placeWholesaleOrderTx(db, { ...input, buyerTenantId: input.tenantId });
      if (!r.ok) {
        const code = r.reason === "listing_not_found" ? "NOT_FOUND" : "BAD_REQUEST";
        throw new TRPCError({ code, message: `Wholesale order refused: ${r.reason}${r.detail ? ` (${r.detail})` : ""}` });
      }
      return r;
    }),

  /**
   * WhatsApp phone-buyer checkout (hardened public): pay-now only. Trade
   * credit requires a buyer tenant and goes through placeOrder. Returns the
   * caller's own order id + totals only — no supplier internals.
   */
  placeOrderByPhone: publicProcedure
    .input(z.object({
      listingId: z.string().uuid(),
      quantity: z.number().int().positive().max(1_000_000),
      buyerPhone: phoneSchema,
      idempotencyKey: z.string().uuid().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      const r = await placeWholesaleOrderTx(db, {
        listingId: input.listingId,
        quantity: input.quantity,
        buyerPhone: input.buyerPhone,
        paymentMode: "pay_now",
        idempotencyKey: input.idempotencyKey,
      });
      if (!r.ok) {
        const code = r.reason === "listing_not_found" ? "NOT_FOUND" : "BAD_REQUEST";
        throw new TRPCError({ code, message: `Wholesale order refused: ${r.reason}` });
      }
      return {
        orderId: r.order.id,
        quantity: r.order.quantity,
        unitPriceCents: r.order.unitPriceCents,
        totalCents: r.order.totalCents,
        currency: r.order.currency,
        status: r.order.status,
      };
    }),

  /** Buyer's own order status by phone (hardened public, minimal view). */
  myOrderByPhone: publicProcedure
    .input(z.object({ orderId: z.string().uuid(), buyerPhone: phoneSchema }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const [order] = await db.select().from(wholesaleOrders).where(
        and(eq(wholesaleOrders.id, input.orderId), eq(wholesaleOrders.buyerPhone, input.buyerPhone)),
      ).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      return {
        orderId: order.id,
        quantity: order.quantity,
        totalCents: order.totalCents,
        currency: order.currency,
        status: order.status,
        createdAt: order.createdAt,
      };
    }),

  // ── Order book (tenant-guarded, supplier or buyer view) ─────────────────
  listOrders: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      role: z.enum(["supplier", "buyer"]).default("supplier"),
      status: z.string().max(20).optional(),
      limit: z.number().int().default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return listWholesaleOrdersTx(db, input);
    }),

  updateOrderStatus: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      orderId: z.string().uuid(),
      status: z.enum(["pending", "confirmed", "paid", "fulfilled", "cancelled"]),
    }))
    .mutation(async ({ input, ctx }) => {
      // W30 hotfix (F7 residual): wholesale order status transitions
      // (confirmed/paid/fulfilled/cancelled) drive trade-credit settlement
      // and stock release — a supplier back-office money op, so an ANALYST
      // membership must not reach it (owner|operator or admin).
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const row = await updateWholesaleOrderStatusTx(db, input);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      return row;
    }),

  /** Platform credit score preview for trade-credit checkout (buyer view). */
  creditScorePreview: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), supplierTenantId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return getMerchantScoreGuarded(input.supplierTenantId, input.tenantId, db);
    }),
});
