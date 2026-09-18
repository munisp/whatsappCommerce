// === W46 uc-money ===
/**
 * ucMoney.ts — tRPC surface for UC-11 (auctions), UC-15 (tips), UC-16
 * (open-amount donations), UC-26 (pre-confirmation order amendments).
 * Thin wrappers over the services (chat commands in nlp.ts ride the SAME
 * service functions on BOTH channels).
 */
import { z } from "zod";
import { protectedProcedure, router, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import { getDb } from "../db";

const tenantCtx = (ctx: any, tenantId: string) => {
  assertTenantAccess(ctx.user, tenantId);
  return ctx;
};

export const ucMoneyRouter = router({
  // ── UC-11 auctions ─────────────────────────────────────────────────────────
  createAuction: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      productId: z.string().nullish(),
      productName: z.string().nullish(),
      startPriceCents: z.number().int().positive(),
      minIncrementCents: z.number().int().positive().optional(),
      reserveCents: z.number().int().positive().nullish(),
      antiSnipeSeconds: z.number().int().min(0).optional(),
      durationHours: z.number().positive().max(24 * 30).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      tenantCtx(ctx, input.tenantId);
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("db unavailable");
      const { createAuction } = await import("../services/auctions");
      return createAuction(db, { ...input, createdBy: String((ctx as any).user?.id ?? "router") });
    }),

  placeBid: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      auctionRef: z.string().nullish(),
      productName: z.string().nullish(),
      bidderRef: z.string(),
      amountCents: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      tenantCtx(ctx, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("db unavailable");
      const { placeBid } = await import("../services/auctions");
      return placeBid(db, input);
    }),

  /** Close sweep for due auctions (tenant-scoped; cron/scheduler may call the service directly). */
  sweepAuctions: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      tenantCtx(ctx, input.tenantId);
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("db unavailable");
      const { sweepDueAuctions } = await import("../services/auctions");
      return sweepDueAuctions(db, input.tenantId, {});
    }),

  // ── UC-15 tips ─────────────────────────────────────────────────────────────
  setTip: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerRef: z.string(),
      orderId: z.string().nullish(),
      tipCents: z.number().int().min(0),
    }))
    .mutation(async ({ ctx, input }) => {
      tenantCtx(ctx, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("db unavailable");
      const { setOrderTip } = await import("../services/tipping");
      return setOrderTip(db, input);
    }),

  // ── UC-16 open-amount / donations ──────────────────────────────────────────
  createDonation: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      customerRef: z.string(),
      productId: z.string().nullish(),
      productName: z.string().nullish(),
      amountCents: z.number().int().positive(),
      note: z.string().max(500).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      tenantCtx(ctx, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("db unavailable");
      const { createDonationCheckout } = await import("../services/donations");
      return createDonationCheckout(db, input);
    }),

  // ── UC-26 pre-confirmation order amendment ─────────────────────────────────
  amendOrder: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string(),
      lines: z.array(z.object({ productId: z.string(), qty: z.number().int().positive() })).min(1),
      reason: z.string().max(500).nullish(),
      customerRef: z.string().nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      tenantCtx(ctx, input.tenantId);
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("db unavailable");
      const { amendOrder } = await import("../services/orderAmendments");
      return amendOrder(db, { ...input, actorId: String((ctx as any).user?.id ?? "router") });
    }),
});
// === END W46 uc-money ===
