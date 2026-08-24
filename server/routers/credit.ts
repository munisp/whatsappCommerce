/**
 * W27 credit — tenant-guarded merchant credit router.
 *
 *   credit.score               view the merchant's deterministic credit score
 *   credit.offers              current micro-loan offers (from the score tier)
 *   credit.accept              accept an offer → disburse to merchant wallet
 *   credit.loans               loan list + derived repayment schedule
 *   credit.repay               manual repayment from the wallet
 *   credit.certificate         issue signed portable credit certificate
 *                              (JSON payload + signature + printable HTML)
 *
 * Every procedure: protectedProcedure + tenantId in input +
 * assertTenantAccess BEFORE any db work. merchantId defaults to tenantId
 * (first-party merchant self-service); specifying a different merchantId
 * requires access to that merchant tenant too.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { getMerchantScore } from "../services/creditScore";
import {
  acceptLoanTx,
  getLoanOffersTx,
  listLoansTx,
  repayLoanManualTx,
  repaymentScheduleFor,
} from "../services/tradeCredit/microLoans";
import { issueCreditCertificateTx } from "../services/creditCertificate";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

function assertMerchantAccess(user: any, tenantId: string, merchantId: string) {
  assertTenantAccess(user, tenantId);
  if (merchantId !== tenantId) assertTenantAccess(user, merchantId);
}

const scoped = z.object({
  tenantId: z.string().min(1),
  merchantId: z.string().min(1).optional(),
});

export const creditRouter = router({
  /** Merchant credit score (frozen getMerchantScore contract result). */
  score: protectedProcedure
    .input(scoped)
    .query(async ({ input, ctx }) => {
      const merchantId = input.merchantId ?? input.tenantId;
      assertMerchantAccess(ctx.user, input.tenantId, merchantId);
      return getMerchantScore(input.tenantId, merchantId, await requireDb());
    }),

  /** Current micro-loan offers derived from the score tier. */
  offers: protectedProcedure
    .input(scoped)
    .query(async ({ input, ctx }) => {
      const merchantId = input.merchantId ?? input.tenantId;
      assertMerchantAccess(ctx.user, input.tenantId, merchantId);
      return getLoanOffersTx(await requireDb(), input.tenantId, merchantId);
    }),

  /** Accept an offer: creates the loan and disburses to the wallet. */
  accept: protectedProcedure
    .input(scoped.extend({ principalCents: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const merchantId = input.merchantId ?? input.tenantId;
      assertMerchantAccess(ctx.user, input.tenantId, merchantId);
      // W30 (V2#1): KYB is a hard precondition for taking on credit —
      // fail-closed at the router level (tradeCredit internals untouched).
      const db = await requireDb();
      const { requireApprovedKyb } = await import("../services/kycGate");
      await requireApprovedKyb(input.tenantId, db);
      const result = await acceptLoanTx(db, {
        tenantId: input.tenantId,
        merchantId,
        principalCents: input.principalCents,
      });
      if (!result.ok) {
        const code = result.reason === "existing_loan" ? "CONFLICT" : "BAD_REQUEST";
        throw new TRPCError({ code, message: `loan accept failed: ${result.reason}` });
      }
      return result;
    }),

  /** Loan list with the derived repayment schedule per loan. */
  loans: protectedProcedure
    .input(scoped)
    .query(async ({ input, ctx }) => {
      const merchantId = input.merchantId ?? input.tenantId;
      assertMerchantAccess(ctx.user, input.tenantId, merchantId);
      const rows = await listLoansTx(await requireDb(), input.tenantId, merchantId);
      return rows.map((loan) => ({ loan, schedule: repaymentScheduleFor(loan) }));
    }),

  /** Manual repayment from the merchant wallet balance. */
  repay: protectedProcedure
    .input(scoped.extend({
      loanId: z.string().min(1),
      amountCents: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      const merchantId = input.merchantId ?? input.tenantId;
      assertMerchantAccess(ctx.user, input.tenantId, merchantId);
      const db = await requireDb();
      // Scope check: the loan must belong to this tenant+merchant.
      const loans = await listLoansTx(db, input.tenantId, merchantId);
      if (!loans.some((l) => l.id === input.loanId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "loan not found" });
      }
      const result = await repayLoanManualTx(db, { loanId: input.loanId, amountCents: input.amountCents });
      if (!result.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "repayment not applied" });
      return result;
    }),

  /**
   * Issue a signed portable credit certificate (banks/MFIs). Returns the
   * JSON payload + hex HMAC signature + printable HTML (portal renders a
   * download / print-to-PDF).
   */
  certificate: protectedProcedure
    .input(scoped)
    .mutation(async ({ input, ctx }) => {
      const merchantId = input.merchantId ?? input.tenantId;
      assertMerchantAccess(ctx.user, input.tenantId, merchantId);
      return issueCreditCertificateTx(await requireDb(), input.tenantId, merchantId);
    }),
});
