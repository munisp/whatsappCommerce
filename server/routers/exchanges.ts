/**
 * === W43 exchanges (Coder B): exchanges router ===
 * Merchant/operator surface for the exchange lifecycle in
 * services/exchanges.ts (request, decide, transition, receive, list).
 * All procedures are tenant-scoped (assertTenantAccess) and the service
 * layer applies assertTenantActive on every state mutation.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { exchangeRequests } from "../../drizzle/schema";
import {
  decideExchange,
  receiveExchange,
  requestExchange,
  transitionExchange,
  EXCHANGE_STATUSES,
} from "../services/exchanges";

const statusEnum = z.enum(EXCHANGE_STATUSES);

export const exchangesRouter = router({
  /** List exchange requests for a tenant (optionally by status/order). */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: statusEnum.optional(),
      orderId: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const conds = [eq(exchangeRequests.tenantId, input.tenantId)];
      if (input.status) conds.push(eq(exchangeRequests.status, input.status));
      if (input.orderId) conds.push(eq(exchangeRequests.orderId, input.orderId));
      return db.select().from(exchangeRequests)
        .where(and(...conds))
        .orderBy(desc(exchangeRequests.createdAt))
        .limit(input.limit);
    }),

  /** Open an exchange request (price delta computed server-side). */
  request: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string(),
      fromOrderLineId: z.string(),
      toProductId: z.string(),
      toVariantId: z.string().nullish(),
      qty: z.number().int().min(1),
      rmaRequestId: z.string().uuid().nullish(),
      damaged: z.boolean().optional(),
      requestedBy: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return requestExchange(db, { ...input, requestedVia: "admin" });
    }),

  /** Approve (settles the price delta) or reject. */
  decide: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      exchangeId: z.string().uuid(),
      approve: z.boolean(),
      note: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return decideExchange(db, { ...input, actorId: String(ctx.user?.id ?? "merchant") });
    }),

  /** Non-stock transitions: in_transit / completed / cancelled. */
  transition: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      exchangeId: z.string().uuid(),
      to: statusEnum,
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return transitionExchange(db, { ...input, actorId: String(ctx.user?.id ?? "merchant") });
    }),

  /** Goods received → restock/write-off + claim-first replacement reserve. */
  receive: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      exchangeId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      return receiveExchange(db, { ...input, actorId: String(ctx.user?.id ?? "merchant") });
    }),
});
// === END W43 exchanges ===
