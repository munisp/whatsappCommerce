// === W44 giftcards-referrals (Coder A): gift cards + referrals merchant router ===
/**
 * Merchant/operator surface for gift cards (issue / disable / adjust / list /
 * transactions) and the referral program (reward config + event listing).
 * All procedures are tenant-scoped (assertTenantAccess) and the service layer
 * applies assertTenantActive on every state mutation. Adjust is audited
 * (gift_card_transactions 'adjust' row + note AND audit_logs entry).
 */
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { giftCardTransactions, referralEvents, tenants } from "../../drizzle/schema";
import { adjustGiftCard, disableGiftCard, issueGiftCard, listGiftCards } from "../services/giftCards";

export const giftCardsRouter = router({
  /** List gift cards for a tenant (newest first). */
  list: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return listGiftCards(input.tenantId, db, input.limit);
    }),

  /** Transaction rail (audit) for one card. */
  transactions: protectedProcedure
    .input(z.object({ tenantId: z.string(), giftCardId: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return db.select().from(giftCardTransactions)
        .where(eq(giftCardTransactions.giftCardId, input.giftCardId))
        .orderBy(desc(giftCardTransactions.createdAt))
        .limit(input.limit);
    }),

  /** Issue an ACTIVE gift card directly (no payment) + audit row. */
  issue: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      amountCents: z.number().int().positive(),
      currency: z.string().length(3).optional(),
      customerId: z.string().min(1).nullish(),
      expiresAt: z.string().datetime().nullish(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return issueGiftCard(input.tenantId, {
        amountCents: input.amountCents,
        currency: input.currency,
        customerId: input.customerId ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        actor: String(ctx.user?.id ?? "merchant"),
        note: input.note,
      }, db);
    }),

  /** Disable a card (claim-first; terminal-state cards CONFLICT). */
  disable: protectedProcedure
    .input(z.object({ tenantId: z.string(), code: z.string().min(4).max(64) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return disableGiftCard(input.tenantId, input.code, String(ctx.user?.id ?? "merchant"), db);
    }),

  /** Adjust balance by a signed delta (integer cents) with a mandatory note. */
  adjust: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      code: z.string().min(4).max(64),
      deltaCents: z.number().int().refine((v) => v !== 0, "deltaCents must be non-zero"),
      note: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return adjustGiftCard(input.tenantId, input.code, input.deltaCents, String(ctx.user?.id ?? "merchant"), input.note, db);
    }),
});

export const referralsRouter = router({
  /** List referral events for a tenant (newest first). */
  events: protectedProcedure
    .input(z.object({ tenantId: z.string(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return db.select().from(referralEvents)
        .where(eq(referralEvents.tenantId, input.tenantId))
        .orderBy(desc(referralEvents.createdAt))
        .limit(input.limit);
    }),

  /** Configure the referrer reward (integer kobo; 0 disables the program). */
  setRewardCents: protectedProcedure
    .input(z.object({ tenantId: z.string(), rewardCents: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      if (!tenant) throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
      const { assertTenantActive } = await import("../services/tenantGuard");
      assertTenantActive(tenant);
      await db.update(tenants).set({ referralRewardCents: input.rewardCents, updatedAt: new Date() })
        .where(eq(tenants.id, input.tenantId));
      return { ok: true as const, referralRewardCents: input.rewardCents };
    }),
});
