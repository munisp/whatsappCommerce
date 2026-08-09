/**
 * Trade credit engine — public API.
 *
 * S2/S3 import EXACTLY these signatures from this module:
 *
 *   drawOnCredit(args):        Promise<DrawResult>
 *   getCreditAccount(s, b):    Promise<CreditAccount | null>
 *   suggestLimit(b, s):        Promise<{ score; suggestedLimitCents; reasons }>
 *   applyRepayment(args):      Promise<{ ok; outstandingAfter }>
 *   runDunningCheck(now?):     Promise<{ reminded; feesApplied; frozen }>
 *
 * Each public function resolves the shared db handle and delegates to the
 * exported `*Tx` core (which takes the caller's db/tx handle per repo
 * convention — services/inventory.ts — so callers composing larger
 * transactions can reuse the same primitives).
 */
import { getDb } from "../../db";
import type { CreditAccount } from "../../../drizzle/schema";
import { getCreditAccountTx, type DbHandle } from "./accounts";
import { drawOnCreditTx, type DrawArgs, type DrawResult } from "./draw";
import { applyRepaymentTx, type RepaymentArgs, type RepaymentResult } from "./repayment";
import { suggestLimitTx, type CreditScoreResult } from "./scoring";
import { runDunningCheckTx, type DunningResult } from "./dunning";

// Re-export the tx-level cores and account-admin helpers for the router and
// for other services composing credit flows inside larger transactions.
export * from "./accounts";
export { drawOnCreditTx, type DrawArgs, type DrawResult } from "./draw";
export { applyRepaymentTx, type RepaymentArgs, type RepaymentResult } from "./repayment";
export { suggestLimitTx, formatNairaCompact, type CreditScoreResult } from "./scoring";
export { runDunningCheckTx, LATE_FEE_RATE, FREEZE_AFTER_DAYS, type DunningResult } from "./dunning";

async function requireDb(): Promise<DbHandle> {
  const db = await getDb();
  if (!db) throw new Error("[tradeCredit] database unavailable");
  return db;
}

export async function drawOnCredit(args: {
  supplierTenantId: string;
  buyerTenantId: string;
  amountCents: number;
  poId: string;
  termsDays?: number;
}): Promise<
  | { ok: true; ledgerId: string; outstandingAfter: number }
  | { ok: false; reason: "over_limit" | "no_account" | "frozen" | "closed" }
> {
  return drawOnCreditTx(await requireDb(), args);
}

export async function getCreditAccount(
  supplierTenantId: string,
  buyerTenantId: string,
): Promise<CreditAccount | null> {
  return getCreditAccountTx(await requireDb(), supplierTenantId, buyerTenantId);
}

export async function suggestLimit(
  buyerTenantId: string,
  supplierTenantId: string,
): Promise<{ score: number; suggestedLimitCents: number; reasons: string[] }> {
  return suggestLimitTx(await requireDb(), buyerTenantId, supplierTenantId);
}

export async function applyRepayment(args: {
  accountId: string;
  amountCents: number;
  ref: string;
}): Promise<{ ok: boolean; outstandingAfter: number }> {
  return applyRepaymentTx(await requireDb(), args);
}

export async function runDunningCheck(now?: Date): Promise<{
  reminded: number;
  feesApplied: number;
  frozen: number;
}> {
  return runDunningCheckTx(await requireDb(), now ?? new Date());
}
