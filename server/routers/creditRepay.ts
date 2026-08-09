/**
 * server/routers/creditRepay.ts
 * Buyer-side credit repayment rails (w8). The buyer requests a Paystack link
 * to pay down their trade-credit account (full outstanding or partial); the
 * provider webhook then runs the shared claim-first confirm path
 * (paymentConfirm) whose post-success hook applies the repayment exactly-once.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { createRepaymentLink, CreditRepayError, type CreditRepayErrorCode } from "../services/creditRepayLink";

const TRPC_CODE: Record<CreditRepayErrorCode, TRPCError["code"]> = {
  "credit-account-not-found": "NOT_FOUND",
  "credit-account-forbidden": "FORBIDDEN",
  "nothing-outstanding": "BAD_REQUEST",
  "invalid-amount": "BAD_REQUEST",
  "amount-exceeds-outstanding": "BAD_REQUEST",
  "paystack-not-configured": "PRECONDITION_FAILED",
  "paystack-init-failed": "INTERNAL_SERVER_ERROR",
};

export const creditRepayRouter = router({
  /**
   * Create a Paystack repayment link for the caller's own (buyer) tenant.
   * Tenant isolation: assertTenantAccess runs BEFORE any DB work, and the
   * service additionally verifies the credit account belongs to the buyer.
   */
  requestRepaymentLink: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1), // BUYER tenant
        accountId: z.string().min(1),
        amountCents: z.number().int().positive().optional(), // omitted → full outstanding
        poId: z.string().min(1).optional(),
        customerPhone: z.string().min(5).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      try {
        return await createRepaymentLink(db, {
          buyerTenantId: input.tenantId,
          accountId: input.accountId,
          amountCents: input.amountCents ?? null,
          poId: input.poId ?? null,
          customerPhone: input.customerPhone ?? null,
        });
      } catch (err: any) {
        if (err instanceof CreditRepayError) {
          throw new TRPCError({ code: TRPC_CODE[err.code] ?? "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
});
