/**
 * COD router — W17/F10: cash-on-delivery board, rider cash confirmation,
 * settlement, reconciliation and offline order capture.
 *
 * Every procedure is tenant-guarded: either the input carries tenantId
 * (assertTenantAccess) or it is id-keyed (orderId) and the tenant is resolved
 * from the loaded order before any mutation.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { orders } from "../../drizzle/schema";
import {
  COD_STATES,
  CodTransitionError,
  codEventsForOrder,
  codReconciliation,
  confirmCashCollection,
  listCodOrders,
  orderPaymentSummary,
  settleCod,
  transitionCod,
} from "../services/codFlow";
import { createOfflineOrder } from "../services/offlineOrders";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

/** Load an order by id; the caller's tenant guard runs INLINE in each
 * procedure (authz scanner requirement) right after this resolves. */
async function loadOrder(db: any, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  return order;
}

function actorOf(user: any): string {
  return `user:${user?.id ?? user?.email ?? "unknown"}`;
}

export const codRouter = router({
  /** COD board: orders grouped by codState + payment summaries. */
  board: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const rows = await listCodOrders(db as any, input.tenantId);
      const columns: Record<string, any[]> = Object.fromEntries(COD_STATES.map((s) => [s, []]));
      for (const o of rows) {
        const summary = await orderPaymentSummary(db as any, input.tenantId, o.id);
        columns[o.codState ?? "cod_pending"]?.push({ ...o, paymentSummary: summary });
      }
      return { columns };
    }),

  /** Validated COD transition (assign rider, out for delivery, delivered,
   * delivery_failed (reason), refused, returned). */
  transition: protectedProcedure
    .input(
      z.object({
        orderId: z.string(),
        to: z.enum(COD_STATES),
        actor: z.string().max(128).optional(),
        note: z.string().max(2000).optional(),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const order = await loadOrder(db, input.orderId);
      assertTenantAccess(ctx.user, order.tenantId);
      try {
        return await transitionCod(db as any, {
          tenantId: order.tenantId,
          orderId: order.id,
          to: input.to,
          actor: input.actor ?? actorOf(ctx.user),
          note: input.note ?? null,
          reason: input.reason ?? null,
        });
      } catch (e) {
        if (e instanceof CodTransitionError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        }
        throw e;
      }
    }),

  /** Rider/merchant confirms cash collection. Idempotent: the default claim
   * key derives from orderId + current state + amount, so a replayed call
   * writes nothing and reports applied:false. */
  codConfirmCollection: protectedProcedure
    .input(
      z.object({
        orderId: z.string(),
        amount: z.number().positive(),
        idempotencyKey: z.string().max(256).optional(),
        note: z.string().max(2000).optional(),
        final: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const order = await loadOrder(db, input.orderId);
      assertTenantAccess(ctx.user, order.tenantId);
      try {
        return await confirmCashCollection(db as any, {
          tenantId: order.tenantId,
          orderId: order.id,
          amount: input.amount,
          actor: actorOf(ctx.user),
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey,
          final: input.final,
        });
      } catch (e) {
        if (e instanceof CodTransitionError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        }
        throw e;
      }
    }),

  /** Settle collected rider cash against the order (claim-first idempotent). */
  settle: protectedProcedure
    .input(z.object({ orderId: z.string(), note: z.string().max(2000).optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const order = await loadOrder(db, input.orderId);
      assertTenantAccess(ctx.user, order.tenantId);
      try {
        return await settleCod(db as any, {
          tenantId: order.tenantId,
          orderId: order.id,
          actor: actorOf(ctx.user),
          note: input.note ?? null,
        });
      } catch (e) {
        if (e instanceof CodTransitionError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        }
        throw e;
      }
    }),

  /** Per-day expected vs collected vs variance + unsettled aging list. */
  codReconciliation: protectedProcedure
    .input(z.object({ tenantId: z.string(), windowDays: z.number().int().min(1).max(90).optional() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      return codReconciliation(db as any, input.tenantId, { windowDays: input.windowDays });
    }),

  /** Partial-payment summary for one order (COD partial cash AND online). */
  paymentSummary: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      const order = await loadOrder(db, input.orderId);
      assertTenantAccess(ctx.user, order.tenantId);
      return orderPaymentSummary(db as any, order.tenantId, order.id);
    }),

  /** Audit trail for one COD order. */
  events: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      const order = await loadOrder(db, input.orderId);
      assertTenantAccess(ctx.user, order.tenantId);
      return codEventsForOrder(db as any, order.tenantId, order.id);
    }),

  /** Merchant-captured offline sale (walk-in / phone order, no WhatsApp
   * thread). Reuses the chat-order inventory path (reserveStock). */
  createOfflineOrder: protectedProcedure
    .input(
      z.object({
        tenantId: z.string(),
        customerName: z.string().min(1).max(255),
        customerPhone: z.string().min(3).max(30),
        paymentMethod: z.enum(["cod", "cash", "transfer"]),
        amountPaid: z.number().min(0).optional(),
        currency: z.string().length(3).optional(),
        note: z.string().max(2000).optional(),
        items: z
          .array(
            z.object({
              productId: z.string(),
              qty: z.number().int().min(1),
              unitPrice: z.number().min(0).optional(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const result = await createOfflineOrder(db as any, {
        ...input,
        actor: actorOf(ctx.user),
      });
      if (!result.created) {
        const s = result.shortages?.[0];
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Insufficient stock for product: ${s?.name ?? "unknown"} (requested ${s?.requested}, available ${s?.available})`,
        });
      }
      return result;
    }),
});
