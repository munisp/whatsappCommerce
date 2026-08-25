/**
 * === W32 earlypay-fx (Coder C): fxPayouts router ===
 * Cross-border FX vendor payouts: quote → accept → execute.
 * Tenant guards: every procedure is moneyProcedure/assertTenantAccess
 * scoped (money mutations are owner|operator only). Honest vocabulary:
 * no corridor / no rate / expired → refused with nothing moved.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { router, protectedProcedure, moneyProcedure, assertTenantAccess, assertMoneyAccess } from "../_core/trpc";
import { getDb } from "../db";
import { fxQuotes } from "../../drizzle/schema";
import { acceptFxQuoteTx, createFxQuoteTx, executeFxQuoteTx } from "../services/fxPayouts";

const currencySchema = z.string().regex(/^[A-Za-z]{3}$/, "ISO-4217 currency code");

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

export const fxPayoutsRouter = router({
  /** Mint a rate quote (pluggable source; sim is a labelled fixed table). */
  quote: moneyProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      fromCurrency: currencySchema,
      toCurrency: currencySchema,
      amountCents: z.number().int().positive().max(1_000_000_000_00),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const r = await createFxQuoteTx(db, input);
      if (!r.ok) {
        throw new TRPCError({
          code: r.reason === "invalid" ? "BAD_REQUEST" : "PRECONDITION_FAILED",
          message: r.detail ?? `FX quote ${r.reason}`,
        });
      }
      return r;
    }),

  /** Accept a quote within its expiry (guarded single consume; replay no-op). */
  accept: moneyProcedure
    .input(z.object({ tenantId: z.string().min(1), quoteId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const r = await acceptFxQuoteTx(db, input);
      if (!r.ok) {
        const code = r.reason === "not_found" ? "NOT_FOUND" : r.reason === "expired" ? "PRECONDITION_FAILED" : "CONFLICT";
        const msg = r.reason === "expired"
          ? "FX quote has expired — request a fresh quote"
          : r.reason === "not_quotable"
            ? "Quote cannot be accepted from its current status"
            : "Quote not found";
        throw new TRPCError({ code, message: msg });
      }
      return r;
    }),

  /**
   * Execute an accepted quote: locked wallet debit in from_currency +
   * Mojaloop delivery. No live corridor → honest UNAVAILABLE and NOTHING
   * moves (never a simulated cross-border delivery).
   */
  execute: moneyProcedure
    .input(z.object({ tenantId: z.string().min(1), quoteId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await assertMoneyAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      const r = await executeFxQuoteTx(db, input);
      if (!r.ok) {
        const code =
          r.reason === "not_found" ? "NOT_FOUND"
          : r.reason === "no_corridor" ? "PRECONDITION_FAILED"
          : r.reason === "expired" ? "PRECONDITION_FAILED"
          : r.reason === "insufficient_funds" ? "BAD_REQUEST"
          : r.reason === "rail_failed" ? "BAD_GATEWAY"
          : "CONFLICT";
        throw new TRPCError({ code, message: r.detail ?? `FX payout ${r.reason}` });
      }
      return r;
    }),

  /** Tenant's own quote book (read-only). */
  list: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await dbOrThrow();
      return db.select().from(fxQuotes)
        .where(eq(fxQuotes.tenantId, input.tenantId))
        .orderBy(desc(fxQuotes.createdAt))
        .limit(input.limit);
    }),
});
// === END W32 earlypay-fx (fxPayouts router) ===
