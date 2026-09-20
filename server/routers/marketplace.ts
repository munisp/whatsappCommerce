import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { router, protectedProcedure, adminProcedure, operatorProcedure, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import * as connectorMarketplace from "../services/marketplace";
import { getDb } from "../db";
import { kycApplications, marketplaceSellers, marketplaceCommissions } from "../../drizzle/schema";
import { writeAuditLog } from "./audit";
import { randomUUID } from "crypto";

/**
 * W40 tenancy (TEN-11): a tenant may only onboard marketplace sellers once
 * its own KYB is approved — an unvetted tenant must not be able to attach
 * payout bank details to the platform. Returns true when an approved KYB
 * application exists for the tenant.
 */
async function hasApprovedKyb(db: any, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: kycApplications.id })
    .from(kycApplications)
    .where(and(
      eq(kycApplications.tenantId, tenantId),
      eq(kycApplications.type, "kyb"),
      eq(kycApplications.status, "approved"),
    ))
    .limit(1)
    .catch(() => []);
  return rows.length > 0;
}

export const marketplaceRouter = router({
  // ── Seller Onboarding ────────────────────────────────────────────────────
  /**
   * W40 (TEN-11): seller registration is an authenticated merchant action —
   * the anonymous arbitrary-tenantId registration (bank details dropped into
   * a VICTIM tenant's seller list) is removed. Callers must be signed in and
   * may only register into their OWN tenant (platform admins bypass), the
   * tenant must have passed KYB, and bank details are validated as a set.
   */
  registerSeller: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      businessName: z.string().min(2),
      ownerPhone: z.string().min(7).max(20).regex(/^\+?[0-9][0-9\s-]*$/, "Invalid owner phone number"),
      ownerName: z.string().optional(),
      email: z.string().email().optional(),
      category: z.string().optional(),
      commissionRate: z.string().default("10.00"),
      bankAccountNumber: z.string().regex(/^[0-9]{6,20}$/, "Bank account number must be 6-20 digits").optional(),
      bankCode: z.string().regex(/^[A-Za-z0-9]{2,12}$/, "Invalid bank code").optional(),
      bankName: z.string().min(2).max(120).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Own tenant only (admins bypass for back-office onboarding).
      assertTenantAccess(ctx.user, input.tenantId);
      // Bank details are all-or-nothing: a partial payout destination is
      // never stored (a payout to an unverifiable account is a TEN-23 loss).
      const bankFields = [input.bankAccountNumber, input.bankCode, input.bankName];
      if (bankFields.some((f) => f !== undefined && f !== "") && bankFields.some((f) => f === undefined || f === "")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Bank details must include account number, bank code and bank name together (or none)",
        });
      }
      const db = (await getDb())!;
      // KYB gate: the tenant itself must be verified before it can attach
      // sellers with payout destinations.
      if (!(await hasApprovedKyb(db, input.tenantId))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Tenant KYB must be approved before registering marketplace sellers",
        });
      }
      const id = randomUUID();
      const now = new Date();
      // W40 merger fix-forward: bank fields are NOT table columns — the
      // all-or-nothing set is stored in the bankAccount jsonb column (a
      // bare {...input} spread silently DROPPED them, losing the seller's
      // payout destination while claiming it was stored).
      const { bankAccountNumber, bankCode, bankName, ...sellerFields } = input;
      await db.insert(marketplaceSellers).values({
        id,
        ...sellerFields,
        bankAccount: bankAccountNumber ? { accountNumber: bankAccountNumber, bankCode, bankName } : null,
        status: "pending", createdAt: now, updatedAt: now,
      });
      return { id, status: "pending" };
      // === END W40 merger fix ===
    }),

  listSellers: protectedProcedure
    .input(z.object({ tenantId: z.string(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const conds = [eq(marketplaceSellers.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(marketplaceSellers.status, input.status as "pending" | "active" | "suspended" | "rejected"));
      return db.select().from(marketplaceSellers).where(and(...conds)).orderBy(desc(marketplaceSellers.createdAt)).limit(input.limit);
    }),

  getSeller: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [seller] = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.id, input.id));
      if (!seller) return null;
      assertTenantAccess(ctx.user, seller.tenantId);
      return seller;
    }),

  updateSellerStatus: adminProcedure
    .input(z.object({ id: z.string(), status: z.enum(["active", "suspended", "rejected"]) }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      // W40 (TEN-4): admin lifecycle actions on sellers are audited with
      // before/after state (cross-tenant admin actions must be attributable).
      const [before] = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.id, input.id)).catch(() => []);
      await db.update(marketplaceSellers).set({ status: input.status, updatedAt: new Date() }).where(eq(marketplaceSellers.id, input.id));
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "marketplace.updateSellerStatus",
        entityType: "marketplace_seller",
        entityId: input.id,
        tenantId: before?.tenantId ?? null,
        summary: `Seller ${before?.businessName ?? input.id} status ${before?.status ?? "?"} → ${input.status}`,
        before: before ? { status: before.status } : null,
        after: { status: input.status },
      });
      return { ok: true };
    }),

  updateSellerCommission: adminProcedure
    .input(z.object({ id: z.string(), commissionRate: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [before] = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.id, input.id)).catch(() => []);
      await db.update(marketplaceSellers).set({ commissionRate: input.commissionRate, updatedAt: new Date() }).where(eq(marketplaceSellers.id, input.id));
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "marketplace.updateSellerCommission",
        entityType: "marketplace_seller",
        entityId: input.id,
        tenantId: before?.tenantId ?? null,
        summary: `Seller ${before?.businessName ?? input.id} commission ${before?.commissionRate ?? "?"} → ${input.commissionRate}`,
        before: before ? { commissionRate: before.commissionRate } : null,
        after: { commissionRate: input.commissionRate },
      });
      return { ok: true };
    }),

  // ── Commission Engine ────────────────────────────────────────────────────
  /**
   * W30 (V3#12): commissions are DERIVED SERVER-SIDE — sale amount/currency
   * come from the real order, the rate from the seller's tenant config
   * (admin-set via updateSellerCommission), never from the caller. One
   * commission row per order (unique orderId backstop; replays return the
   * existing row).
   */
  recordCommission: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      sellerId: z.string(),
      orderId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const { orders } = await import("../../drizzle/schema");
      const [seller] = await db.select().from(marketplaceSellers)
        .where(and(eq(marketplaceSellers.id, input.sellerId), eq(marketplaceSellers.tenantId, input.tenantId))).limit(1);
      if (!seller) throw new TRPCError({ code: "NOT_FOUND", message: "Seller not found in this tenant" });
      const [order] = await db.select().from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.tenantId, input.tenantId))).limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found in this tenant" });

      const saleAmount = Number(order.totalAmount);
      if (!Number.isFinite(saleAmount) || saleAmount < 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Order has no valid total" });
      }
      const rate = Number(seller.commissionRate ?? "0");
      if (!Number.isFinite(rate) || rate < 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Seller has no valid commission rate configured" });
      }
      // Integer minor units: convert once, apply the percent rate, round once.
      const saleMinor = Math.round(saleAmount * 100);
      const commissionMinor = Math.round(saleMinor * rate / 100);
      const id = randomUUID();
      const now = new Date();
      const inserted = await db.insert(marketplaceCommissions).values({
        id,
        sellerId: seller.id,
        orderId: order.id,
        saleAmount: saleAmount.toFixed(2),
        commissionRate: rate.toFixed(2),
        commissionAmount: (commissionMinor / 100).toFixed(2),
        currency: order.currency ?? "NGN",
        status: "pending",
        createdAt: now,
      }).onConflictDoNothing().returning({ id: marketplaceCommissions.id });
      if (inserted.length === 0) {
        const [existing] = await db.select().from(marketplaceCommissions)
          .where(eq(marketplaceCommissions.orderId, input.orderId)).limit(1);
        return { id: existing?.id ?? null, alreadyRecorded: true };
      }
      return { id };
    }),

  listCommissions: protectedProcedure
    .input(z.object({ tenantId: z.string().optional(), sellerId: z.string().optional(), status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      const db = (await getDb())!;
      // W12.1: explicit tenantId filters must pass tenant access; non-admins
      // without a filter are scoped to their own tenant.
      let tenantId = input.tenantId;
      if (tenantId) {
        assertTenantAccess(ctx.user, tenantId);
      } else if (ctx.user.role !== "admin") {
        if (!ctx.user.tenantId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can only access your own tenant's data" });
        }
        tenantId = ctx.user.tenantId;
      }
      const conds: any[] = [];
      // Commissions carry no tenantId column — scope via the seller's tenant.
      if (tenantId) {
        conds.push(inArray(
          marketplaceCommissions.sellerId,
          db.select({ id: marketplaceSellers.id }).from(marketplaceSellers)
            .where(eq(marketplaceSellers.tenantId, tenantId)),
        ));
      }
      if (input.sellerId) conds.push(eq(marketplaceCommissions.sellerId, input.sellerId));
      if (input.status) conds.push(eq(marketplaceCommissions.status, input.status as "pending" | "paid" | "disputed" | "waived"));
      const query = db.select().from(marketplaceCommissions);
      if (conds.length > 0) return query.where(and(...conds)).orderBy(desc(marketplaceCommissions.createdAt)).limit(input.limit);
      return query.orderBy(desc(marketplaceCommissions.createdAt)).limit(input.limit);
    }),

  settleCommission: protectedProcedure
    .input(z.object({ id: z.string(), paidAt: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = (await getDb())!;
      const [commission] = await db.select().from(marketplaceCommissions).where(eq(marketplaceCommissions.id, input.id)).limit(1);
      if (!commission) throw new TRPCError({ code: "NOT_FOUND", message: "Commission not found" });
      // Commissions are keyed by sellerId — assert via the seller's tenant.
      const [seller] = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.id, commission.sellerId)).limit(1);
      if (!seller) throw new TRPCError({ code: "NOT_FOUND", message: "Seller not found" });
      // Flips a commission to "paid" — real payout accounting, finance-gated.
      await assertMoneyAccess(ctx.user, seller.tenantId);
      // W30 (V3#12): guarded settle — only a pending commission can be paid,
      // exactly once (double-settle / settle-disputed no longer flips).
      const settled = await db.update(marketplaceCommissions)
        .set({ status: "paid", settledAt: new Date(input.paidAt ?? Date.now()) })
        .where(and(eq(marketplaceCommissions.id, input.id), eq(marketplaceCommissions.status, "pending")))
        .returning({ id: marketplaceCommissions.id });
      if (settled.length === 0) {
        throw new TRPCError({ code: "CONFLICT", message: `Commission is ${commission.status} — only pending commissions can be settled` });
      }
      return { ok: true };
    }),

  // ── Marketplace Stats ────────────────────────────────────────────────────
  marketplaceStats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = (await getDb())!;
      const sellers = await db.select().from(marketplaceSellers).where(eq(marketplaceSellers.tenantId, input.tenantId));
      const commissions = await db.select().from(marketplaceCommissions);
      const totalCommission = commissions.reduce((sum, c) => sum + parseFloat(c.commissionAmount ?? "0"), 0);
      const paidCommission = commissions.filter(c => c.status === "paid").reduce((sum, c) => sum + parseFloat(c.commissionAmount ?? "0"), 0);
      return {
        totalSellers: sellers.length,
        activeSellers: sellers.filter(s => s.status === "active").length,
        pendingSellers: sellers.filter(s => s.status === "pending").length,
        totalCommissionEarned: totalCommission.toFixed(2),
        paidCommission: paidCommission.toFixed(2),
        pendingCommission: (totalCommission - paidCommission).toFixed(2),
      };
    }),

  // ── Integrations Marketplace Lite (F7) ──────────────────────────────────
  // Connector registry / install / uninstall / health. Reads are tenant-
  // scoped; mutations are operator-gated and audit-logged in the service.

  listConnectors: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return connectorMarketplace.listConnectors({ tenantId: input.tenantId });
    }),

  installConnector: operatorProcedure
    .input(z.object({ tenantId: z.string(), key: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await connectorMarketplace.installConnector({
          tenantId: input.tenantId,
          key: input.key,
          actorId: String(ctx.user!.id),
          actorRole: ctx.user!.role,
        });
      } catch (err: any) {
        if (String(err?.message ?? "").startsWith("Unknown connector")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  uninstallConnector: operatorProcedure
    .input(z.object({ tenantId: z.string(), key: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await connectorMarketplace.uninstallConnector({
          tenantId: input.tenantId,
          key: input.key,
          actorId: String(ctx.user!.id),
          actorRole: ctx.user!.role,
        });
      } catch (err: any) {
        if (String(err?.message ?? "").startsWith("Unknown connector")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  connectorHealth: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      return connectorMarketplace.marketplaceHealth({ tenantId: input.tenantId });
    }),
});
