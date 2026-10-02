// === W59 banking-pos ===
/**
 * W59 banking-pos (Feature 1) — merchant payout accounts service.
 *
 * Multi-account withdrawal destinations on top of the legacy single-account
 * columns on merchant_wallets (bankAccountName/bankAccountNumber/bankCode).
 *
 * Contracts:
 *  - ADD is fail-closed on name enquiry: resolveAccount (NIBSS, via the
 *    account's rail — paystack | flutterwave) MUST return the bank's name on
 *    file BEFORE any row is inserted. A failed resolution = no row.
 *  - Idempotent re-add: unique(walletId, provider, accountNumber); re-adding
 *    the same triple returns the existing row (23505-translated).
 *  - Legacy backfill: a wallet with legacy bankAccount* columns and no
 *    merchant_payout_accounts rows gets exactly one primary row (provider
 *    'paystack', the historical rail) — idempotent via the unique index.
 *  - Single-primary: setPrimary runs in one transaction with the wallet row
 *    locked (SELECT ... FOR UPDATE), clears siblings, then sets the target.
 *  - numeric(14,2) major-unit wallet balances / integer-cent conversions live
 *    in callers (escrow.requestWithdrawal); this service deals in rows only.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { merchantPayoutAccounts, merchantWallets } from "../../drizzle/schema";
import { ENV } from "../_core/env";

type Db = any;

export type PayoutProvider = "paystack" | "flutterwave";

export interface WithdrawalAccount {
  accountId: string | null; // null when falling back to legacy wallet columns
  provider: PayoutProvider;
  accountName: string;
  accountNumber: string;
  bankCode: string;
}

function assertProvider(p: string): asserts p is PayoutProvider {
  if (p !== "paystack" && p !== "flutterwave") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "provider must be 'paystack' or 'flutterwave'" });
  }
}

/** Rail-dispatching name enquiry. Throws (fail-closed) on any failure. */
export async function resolveAccountOnRail(
  provider: PayoutProvider,
  accountNumber: string,
  bankCode: string,
): Promise<{ accountNumber: string; accountName: string }> {
  if (provider === "flutterwave") {
    const { resolveAccount } = await import("./payments/flutterwaveTransfer");
    return resolveAccount(accountNumber, bankCode);
  }
  const { resolveAccount } = await import("./payments/paystackTransfer");
  return resolveAccount(ENV.paystackSecretKey, accountNumber, bankCode);
}

/** Finds (or creates) the tenant's PSP wallet. */
async function getOrCreateMerchantWallet(db: Db, tenantId: string) {
  const [wallet] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (wallet) return wallet;
  const id = crypto.randomUUID();
  await db.insert(merchantWallets).values({ id, tenantId, custodyMode: "psp" }).onConflictDoNothing();
  const [created] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "wallet unavailable" });
  return created;
}

export async function listPayoutAccounts(db: Db, tenantId: string) {
  return db.select().from(merchantPayoutAccounts)
    .where(eq(merchantPayoutAccounts.tenantId, tenantId))
    .orderBy(merchantPayoutAccounts.createdAt);
}

/**
 * Idempotent legacy backfill: copies merchant_wallets.bankAccount* into one
 * primary merchant_payout_accounts row (provider 'paystack'). Runs before
 * reads/writes that depend on the new table; the unique index makes
 * concurrent/duplicate backfills collapse into one row.
 */
export async function backfillLegacyPayoutAccount(db: Db, tenantId: string) {
  const [wallet] = await db.select().from(merchantWallets).where(eq(merchantWallets.tenantId, tenantId));
  if (!wallet || !wallet.bankAccountNumber || !wallet.bankCode) return null;
  const [existing] = await db.select({ id: merchantPayoutAccounts.id }).from(merchantPayoutAccounts)
    .where(and(eq(merchantPayoutAccounts.walletId, wallet.id), eq(merchantPayoutAccounts.provider, "paystack"),
      eq(merchantPayoutAccounts.accountNumber, wallet.bankAccountNumber)));
  if (existing) return existing.id;
  try {
    const [row] = await db.insert(merchantPayoutAccounts).values({
      tenantId,
      walletId: wallet.id,
      bankCode: wallet.bankCode,
      accountNumber: wallet.bankAccountNumber,
      // The legacy columns were set via the step-up-gated W30 procedure; the
      // name on file is the audited payout destination name.
      accountName: wallet.bankAccountName ?? "On file",
      provider: "paystack",
      label: "Primary (migrated)",
      isPrimary: true,
      status: "active",
    }).returning({ id: merchantPayoutAccounts.id });
    return row?.id ?? null;
  } catch (err: any) {
    if (String(err?.code) === "23505") return null; // concurrent backfill won
    throw err;
  }
}

export interface AddPayoutAccountInput {
  tenantId: string;
  bankCode: string;
  accountNumber: string;
  provider: string;
  label?: string;
}

/** Adds a verified payout account. FAIL-CLOSED: NIBSS name enquiry must
 *  succeed before the insert. Re-add of the same triple is an idempotent
 *  replay returning the existing row. */
export async function addPayoutAccount(db: Db, input: AddPayoutAccountInput) {
  assertProvider(input.provider);
  if (!/^\d{10}$/.test(input.accountNumber)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "accountNumber must be a 10-digit NUBAN" });
  }
  const wallet = await getOrCreateMerchantWallet(db, input.tenantId);

  // Idempotent replay short-circuit (before spending a name-enquiry call).
  const [existing] = await db.select().from(merchantPayoutAccounts)
    .where(and(eq(merchantPayoutAccounts.walletId, wallet.id), eq(merchantPayoutAccounts.provider, input.provider),
      eq(merchantPayoutAccounts.accountNumber, input.accountNumber)));
  if (existing) return { account: existing, duplicate: true };

  // Fail-closed verification — a failed enquiry throws and NO row is written.
  let resolved: { accountNumber: string; accountName: string };
  try {
    resolved = await resolveAccountOnRail(input.provider, input.accountNumber, input.bankCode);
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Account verification failed (no account saved): ${err?.message ?? err}` });
  }

  const [sibling] = await db.select({ id: merchantPayoutAccounts.id }).from(merchantPayoutAccounts)
    .where(and(eq(merchantPayoutAccounts.walletId, wallet.id), eq(merchantPayoutAccounts.isPrimary, true),
      eq(merchantPayoutAccounts.status, "active")));
  try {
    const [row] = await db.insert(merchantPayoutAccounts).values({
      tenantId: input.tenantId,
      walletId: wallet.id,
      bankCode: input.bankCode,
      accountNumber: resolved.accountNumber,
      accountName: resolved.accountName, // bank's name on file — never trust free-typed names
      provider: input.provider,
      label: input.label ?? null,
      isPrimary: !sibling, // first account becomes primary
      verifiedAt: new Date(),
      status: "active",
    }).returning();
    return { account: row, duplicate: false };
  } catch (err: any) {
    if (String(err?.code) === "23505") {
      const [row] = await db.select().from(merchantPayoutAccounts)
        .where(and(eq(merchantPayoutAccounts.walletId, wallet.id), eq(merchantPayoutAccounts.provider, input.provider),
          eq(merchantPayoutAccounts.accountNumber, input.accountNumber)));
      if (row) return { account: row, duplicate: true };
    }
    throw err;
  }
}

/** Row-locked single-primary flip: locks the wallet row so concurrent
 *  setPrimary calls serialize, clears all siblings, then sets the target.
 *  Target must be an active account on this tenant's wallet. */
export async function setPrimaryPayoutAccount(db: Db, tenantId: string, accountId: string) {
  return db.transaction(async (tx: Db) => {
    const locked = await tx.execute(sql`
      SELECT id FROM merchant_wallets WHERE tenant_id = ${tenantId} FOR UPDATE
    `);
    const walletRow = (locked as unknown as Record<string, unknown>[])[0];
    if (!walletRow) throw new TRPCError({ code: "NOT_FOUND", message: "wallet not found" });
    const walletId = String(walletRow.id);
    const [target] = await tx.select().from(merchantPayoutAccounts)
      .where(and(eq(merchantPayoutAccounts.id, accountId), eq(merchantPayoutAccounts.tenantId, tenantId)));
    if (!target || target.walletId !== walletId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "payout account not found" });
    }
    if (target.status !== "active") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "cannot make a disabled account primary" });
    }
    await tx.update(merchantPayoutAccounts).set({ isPrimary: false, updatedAt: new Date() })
      .where(and(eq(merchantPayoutAccounts.walletId, walletId), eq(merchantPayoutAccounts.isPrimary, true)));
    await tx.update(merchantPayoutAccounts).set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(merchantPayoutAccounts.id, accountId));
    return { ok: true };
  });
}

/** Disables an account (never deletes — money audit trail). If it was
 *  primary, the oldest other ACTIVE account is promoted. */
export async function disablePayoutAccount(db: Db, tenantId: string, accountId: string) {
  return db.transaction(async (tx: Db) => {
    const [target] = await tx.select().from(merchantPayoutAccounts)
      .where(and(eq(merchantPayoutAccounts.id, accountId), eq(merchantPayoutAccounts.tenantId, tenantId)));
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "payout account not found" });
    await tx.update(merchantPayoutAccounts).set({ status: "disabled", isPrimary: false, updatedAt: new Date() })
      .where(eq(merchantPayoutAccounts.id, accountId));
    if (target.isPrimary) {
      const [next] = await tx.select().from(merchantPayoutAccounts)
        .where(and(eq(merchantPayoutAccounts.walletId, target.walletId), eq(merchantPayoutAccounts.status, "active")))
        .orderBy(merchantPayoutAccounts.createdAt);
      if (next) {
        await tx.update(merchantPayoutAccounts).set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(merchantPayoutAccounts.id, next.id));
      }
    }
    return { ok: true };
  });
}

/**
 * Resolves the withdrawal destination for a wallet:
 *  1. explicit payoutAccountId (must belong to tenant + be active), else
 *  2. the active primary merchant_payout_accounts row (after legacy
 *     backfill), else
 *  3. the legacy merchant_wallets.bankAccount* columns (provider 'paystack').
 * Throws BAD_REQUEST when no usable destination exists.
 */
export async function resolveWithdrawalAccount(
  db: Db,
  tenantId: string,
  wallet: { id: string; bankAccountName: string | null; bankAccountNumber: string | null; bankCode: string | null },
  payoutAccountId?: string,
): Promise<WithdrawalAccount> {
  if (payoutAccountId) {
    const [account] = await db.select().from(merchantPayoutAccounts)
      .where(and(eq(merchantPayoutAccounts.id, payoutAccountId), eq(merchantPayoutAccounts.tenantId, tenantId)));
    if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "payout account not found" });
    if (account.status !== "active") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "payout account is disabled" });
    }
    assertProvider(account.provider);
    return {
      accountId: account.id,
      provider: account.provider,
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      bankCode: account.bankCode,
    };
  }
  await backfillLegacyPayoutAccount(db, tenantId);
  const [primary] = await db.select().from(merchantPayoutAccounts)
    .where(and(eq(merchantPayoutAccounts.walletId, wallet.id), eq(merchantPayoutAccounts.isPrimary, true),
      eq(merchantPayoutAccounts.status, "active")));
  if (primary) {
    assertProvider(primary.provider);
    return {
      accountId: primary.id,
      provider: primary.provider,
      accountName: primary.accountName,
      accountNumber: primary.accountNumber,
      bankCode: primary.bankCode,
    };
  }
  if (wallet.bankAccountNumber && wallet.bankCode && wallet.bankAccountName) {
    return {
      accountId: null,
      provider: "paystack",
      accountName: wallet.bankAccountName,
      accountNumber: wallet.bankAccountNumber,
      bankCode: wallet.bankCode,
    };
  }
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "No payout bank details on file — add a payout account first (requires step-up OTP)",
  });
}
