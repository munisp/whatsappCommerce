/**
 * W27 — Group buying router.
 *
 * Tenant-guarded procedures manage deals (create/list/cancel/sweep). Public
 * procedures let customers join a deal and view live progress from a shared
 * WhatsApp/portal link — hardened per the tracking.ts exemplar: strict input
 * validation, deal-id capability (uuid), and PII-scrubbed projections (a
 * participant only ever sees their own phone's hold, never others').
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { router, protectedProcedure, publicProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { groupDealParticipants } from "../../drizzle/schema";
import {
  createGroupDealTx,
  listGroupDealsTx,
  getGroupDealTx,
  getGroupDealProgressTx,
  joinGroupDealTx,
  cancelGroupDealTx,
  sweepGroupDealsTx,
  confirmGroupDealTx,
} from "../services/groupBuy";

const phoneSchema = z.string().regex(/^\+?\d{7,15}$/, "invalid phone");

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

/** Public, PII-scrubbed deal view for shared links. */
function publicDeal(deal: any, progress: any) {
  return {
    dealId: deal.id,
    title: deal.title,
    description: deal.description,
    unitPriceCents: deal.unitPriceCents,
    retailPriceCents: deal.retailPriceCents,
    currency: deal.currency,
    thresholdQty: deal.thresholdQty,
    currentQty: deal.currentQty,
    deadline: deal.deadline,
    status: deal.status,
    progress,
  };
}

export const groupBuyRouter = router({
  // ── Merchant: deal management (tenant-guarded) ──────────────────────────
  createDeal: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      productId: z.string().max(36).optional(),
      unitPriceCents: z.number().int().positive(),
      retailPriceCents: z.number().int().positive().optional(),
      thresholdQty: z.number().int().positive().max(1_000_000),
      currency: z.string().max(8).default("NGN"),
      deadline: z.coerce.date(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      if (input.deadline.getTime() <= Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Deadline must be in the future" });
      }
      return createGroupDealTx(db, input);
    }),

  listDeals: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      status: z.string().max(16).optional(),
      limit: z.number().int().default(50),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return listGroupDealsTx(db, input);
    }),

  dealDetail: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), dealId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const deal = await getGroupDealTx(db, input.dealId);
      if (!deal || deal.tenantId !== input.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found" });
      }
      const progress = await getGroupDealProgressTx(db, input.dealId);
      const participants = await db
        .select()
        .from(groupDealParticipants)
        .where(eq(groupDealParticipants.dealId, input.dealId));
      return { deal, progress, participants };
    }),

  cancelDeal: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), dealId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const ok = await cancelGroupDealTx(db, input);
      if (!ok) throw new TRPCError({ code: "BAD_REQUEST", message: "Deal not found or not open" });
      return { ok: true };
    }),

  /** Merchant-triggered sweep of due deals (also wired to schedulers). */
  sweep: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return sweepGroupDealsTx(db);
    }),

  /** W30 (V1#10): reconciliation surface — holds whose refund never executed. */
  refundFailures: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const { listRefundFailuresTx } = await import("../services/groupBuy");
      return listRefundFailuresTx(db, { tenantId: input.tenantId });
    }),

  // ── Customer: join + live progress (hardened public) ────────────────────
  getDealPublic: publicProcedure
    .input(z.object({ dealId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const deal = await getGroupDealTx(db, input.dealId);
      if (!deal) throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found" });
      const progress = await getGroupDealProgressTx(db, input.dealId);
      return publicDeal(deal, progress);
    }),

  /**
   * Join a deal. The phone number IS the capability: the response exposes
   * only the caller's own hold. Idempotent per (dealId, phone) — replays
   * return the existing hold without double-charging or double-counting.
   */
  joinDeal: publicProcedure
    .input(z.object({
      dealId: z.string().uuid(),
      customerPhone: phoneSchema,
      quantity: z.number().int().positive().max(100_000),
      paymentRef: z.string().max(128).optional(),
      idempotencyKey: z.string().uuid().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      const r = await joinGroupDealTx(db, input);
      if (!r.ok) {
        const code = r.reason === "deal_not_found" ? "NOT_FOUND" : "BAD_REQUEST";
        throw new TRPCError({ code, message: `Cannot join deal: ${r.reason}` });
      }
      return {
        participantId: r.participant.id,
        status: r.participant.status,
        quantity: r.participant.quantity,
        amountCents: r.participant.amountCents,
        currency: r.participant.currency,
        alreadyJoined: r.alreadyJoined === true,
        progress: r.progress,
      };
    }),

  /** Caller's own participation status (phone-scoped, minimal view). */
  myParticipation: publicProcedure
    .input(z.object({ dealId: z.string().uuid(), customerPhone: phoneSchema }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const [p] = await db
        .select()
        .from(groupDealParticipants)
        .where(and(eq(groupDealParticipants.dealId, input.dealId), eq(groupDealParticipants.customerPhone, input.customerPhone)))
        .limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Participation not found" });
      const progress = await getGroupDealProgressTx(db, input.dealId);
      return {
        participantId: p.id,
        status: p.status,
        quantity: p.quantity,
        amountCents: p.amountCents,
        currency: p.currency,
        progress,
      };
    }),
});

// Re-exported for schedulers / journeys (server-side callers).
export { sweepGroupDealsTx, confirmGroupDealTx };
