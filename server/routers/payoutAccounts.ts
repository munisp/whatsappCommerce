// === W59 banking-pos ===
/**
 * W59 banking-pos (Feature 1) — merchant payout accounts router
 * (tenant-scoped; moneyProcedure = owner|operator|finance + explicit
 * assertTenantAccess per the W12/A2-02 authz ratchet).
 *
 *   listBanks      — merged rail bank list (?provider=paystack|flutterwave)
 *   list           — tenant's payout accounts (legacy backfill runs first)
 *   add            — fail-closed verified add (NIBSS name enquiry)
 *   setPrimary     — row-locked single-primary flip
 *   disable        — soft-disable (audit trail preserved)
 *   bankLinkStep   — onboarding helper: verified add as the onboarding
 *                    "bank step"; idempotent on (provider, accountNumber)
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { assertTenantAccess, moneyProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { ENV } from "../_core/env";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const providerSchema = z.enum(["paystack", "flutterwave"]);

export const payoutAccountsRouter = router({
  listBanks: moneyProcedure
    .input(z.object({ tenantId: z.string(), provider: providerSchema.default("paystack") }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      if (input.provider === "flutterwave") {
        const { listBanks } = await import("../services/payments/flutterwaveTransfer");
        return listBanks();
      }
      const { listBanks } = await import("../services/payments/paystackTransfer");
      return listBanks(ENV.paystackSecretKey);
    }),

  list: moneyProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { backfillLegacyPayoutAccount, listPayoutAccounts } = await import("../services/payoutAccounts");
      await backfillLegacyPayoutAccount(db, input.tenantId);
      return listPayoutAccounts(db, input.tenantId);
    }),

  add: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      bankCode: z.string().min(1),
      accountNumber: z.string().length(10),
      provider: providerSchema.default("paystack"),
      label: z.string().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { addPayoutAccount } = await import("../services/payoutAccounts");
      return addPayoutAccount(db, input);
    }),

  setPrimary: moneyProcedure
    .input(z.object({ tenantId: z.string(), accountId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { setPrimaryPayoutAccount } = await import("../services/payoutAccounts");
      return setPrimaryPayoutAccount(db, input.tenantId, input.accountId);
    }),

  disable: moneyProcedure
    .input(z.object({ tenantId: z.string(), accountId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { disablePayoutAccount } = await import("../services/payoutAccounts");
      return disablePayoutAccount(db, input.tenantId, input.accountId);
    }),

  /** Onboarding "bank step": verified add + primary-by-default, idempotent
   *  so onboarding retries never duplicate the row. */
  bankLinkStep: moneyProcedure
    .input(z.object({
      tenantId: z.string(),
      bankCode: z.string().min(1),
      accountNumber: z.string().length(10),
      provider: providerSchema.default("paystack"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      assertTenantAccess(ctx.user, input.tenantId);
      const { addPayoutAccount } = await import("../services/payoutAccounts");
      const result = await addPayoutAccount(db, { ...input, label: "Onboarding" });
      return { ...result, step: "bank" as const };
    }),
});
