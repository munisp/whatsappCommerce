/**
 * Trade credit tRPC router — supplier-side facility administration and
 * buyer-side self-service views.
 *
 * TENANT ISOLATION: every procedure is gated by assertTenantAccess —
 * supplier ops require ctx.user.tenantId === supplierTenantId, buyer ops
 * require ctx.user.tenantId === buyerTenantId. Account-level mutations are
 * additionally claim-first scoped to the owning supplier inside the service
 * layer (update/setStatus include supplier_tenant_id in the WHERE), so a
 * cross-tenant account id can never be mutated even if the input tenantId
 * check were bypassed.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import {
  approveCreditAccountTx,
  createCreditAccountTx,
  getCreditAccountByIdTx,
  getCreditAccountTx,
  listCreditAccountsWithAgingTx,
  listLedgerTx,
  requestCreditAccountTx,
  requestLimitIncreaseTx,
  setCreditAccountStatusTx,
  updateCreditAccountTx,
  CreditAccountExistsError,
  applyRepaymentTx,
  suggestLimitTx,
} from "../services/tradeCredit";
import { creditAccounts } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { requireApprovedKyb } from "../services/kycGate";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** Fetch + ownership-check an account for the supplier side. */
async function requireSupplierAccount(db: any, accountId: string, supplierTenantId: string) {
  const account = await getCreditAccountByIdTx(db, accountId);
  if (!account || account.supplierTenantId !== supplierTenantId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
  }
  return account;
}

/** Fetch + ownership-check an account for the buyer side. */
async function requireBuyerAccount(db: any, accountId: string, buyerTenantId: string) {
  const account = await getCreditAccountByIdTx(db, accountId);
  if (!account || account.buyerTenantId !== buyerTenantId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
  }
  return account;
}

export const tradeCreditRouter = router({
  // ── Supplier-side ────────────────────────────────────────────────────────

  /** Create a credit facility for a buyer. Auto-scores when no explicit score given. */
  createAccount: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      buyerTenantId: z.string().min(1),
      limitCents: z.number().int().min(0),
      termsDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      try {
        return await createCreditAccountTx(db, input);
      } catch (err) {
        if (err instanceof CreditAccountExistsError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  /** Update limit and/or terms (claim-first scoped to the owning supplier). */
  updateAccount: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limitCents: z.number().int().min(0).optional(),
      termsDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      const row = await updateCreditAccountTx(db, input);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
      return row;
    }),

  /** Freeze / unfreeze / close a facility. */
  setAccountStatus: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      status: z.enum(["active", "frozen", "closed"]),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      const row = await setCreditAccountStatusTx(db, input);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Credit account not found" });
      return row;
    }),

  /**
   * Approve a buyer-requested ('pending') facility: flips it to 'active',
   * optionally setting limit/terms in the same claim-first statement.
   * Only matches accounts the supplier owns that are still pending.
   */
  approveAccount: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limitCents: z.number().int().min(0).optional(),
      termsDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      // Hard KYB gate: BOTH sides of the facility must hold an approved KYB
      // application before credit is extended. The account row supplies the
      // buyer side (ownership-checked against the claiming supplier).
      const account = await requireSupplierAccount(db, input.accountId, input.supplierTenantId);
      await requireApprovedKyb(input.supplierTenantId, db);
      await requireApprovedKyb(account.buyerTenantId, db);
      const row = await approveCreditAccountTx(db, input);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pending credit account not found" });
      }
      return row;
    }),

  /** Portfolio list with aging buckets. */
  listAccounts: protectedProcedure
    .input(z.object({ supplierTenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      return listCreditAccountsWithAgingTx(db, input.supplierTenantId);
    }),

  /** Ledger for one of the supplier's accounts. */
  accountLedger: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      await requireSupplierAccount(db, input.accountId, input.supplierTenantId);
      return listLedgerTx(db, input.accountId, input.limit);
    }),

  /** Deterministic limit suggestion for a buyer (see services/scoring). */
  suggestLimit: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      buyerTenantId: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      return suggestLimitTx(db, input.buyerTenantId, input.supplierTenantId);
    }),

  /** Record a buyer repayment (partial allowed; over-repayment refused). */
  recordRepayment: protectedProcedure
    .input(z.object({
      supplierTenantId: z.string().min(1),
      accountId: z.string().min(1),
      amountCents: z.number().int().positive(),
      ref: z.string().min(1).max(128),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.supplierTenantId);
      const db = await requireDb();
      await requireSupplierAccount(db, input.accountId, input.supplierTenantId);
      const res = await applyRepaymentTx(db, {
        accountId: input.accountId,
        amountCents: input.amountCents,
        ref: input.ref,
      });
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Repayment refused (exceeds outstanding balance)",
        });
      }
      return res;
    }),

  // ── Buyer-side ───────────────────────────────────────────────────────────

  /**
   * Buyer asks a supplier to open a credit facility: creates the account in
   * 'pending' status (zero limit — cannot be drawn on until the supplier
   * approves via approveAccount/updateAccount). CONFLICT when a facility
   * (of any status) already exists for the pair.
   */
  requestAccount: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      supplierTenantId: z.string().min(1),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      try {
        return await requestCreditAccountTx(db, input);
      } catch (err) {
        if (err instanceof CreditAccountExistsError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  /** The buyer's own facilities across suppliers, with outstanding. */
  myAccounts: protectedProcedure
    .input(z.object({ buyerTenantId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      return db
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.buyerTenantId, input.buyerTenantId));
    }),

  /** One of the buyer's own accounts (single facility view). */
  myAccount: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      supplierTenantId: z.string().min(1),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      return getCreditAccountTx(db, input.supplierTenantId, input.buyerTenantId);
    }),

  /** Ledger for one of the buyer's own facilities. */
  myLedger: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      accountId: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      await requireBuyerAccount(db, input.accountId, input.buyerTenantId);
      return listLedgerTx(db, input.accountId, input.limit);
    }),

  /**
   * Request a limit increase — writes a zero-amount 'adjustment' ledger note
   * (ref `limitreq:<ts>`) the supplier sees in their ledger view.
   */
  requestLimitIncrease: protectedProcedure
    .input(z.object({
      buyerTenantId: z.string().min(1),
      accountId: z.string().min(1),
      requestedLimitCents: z.number().int().positive(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.buyerTenantId);
      const db = await requireDb();
      const account = await requireBuyerAccount(db, input.accountId, input.buyerTenantId);
      if (account.status === "closed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Credit account is closed" });
      }
      return requestLimitIncreaseTx(db, {
        accountId: input.accountId,
        requestedLimitCents: input.requestedLimitCents,
        note: input.note,
      });
    }),
});
