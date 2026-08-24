/**
 * W27 credit — merchant micro-loans (working capital), extending the trade
 * credit engine. Integrates with (does NOT fork) the existing module:
 * scores come from services/creditScore.ts (frozen contract), money moves
 * over the existing merchant wallet / wallet_transactions rails, and
 * repayment is auto-deducted from settled sales by a sweep job
 * (runLoanRepaymentSweep) that consumes wallet 'escrow_release' ledger
 * entries — escrow.ts / paymentConfirm.ts internals are untouched.
 *
 * ALL money is INTEGER CENTS at this layer; wallet columns are numeric
 * major units and conversion happens exactly once at the wallet boundary
 * (shared/escrowAmounts helpers). No unseeded randomness; the sweep is
 * idempotent via merchant_loan_repayments.reference
 * (`loanrepay:<loanId>:<walletTxId>`, unique index) and the wallet
 * (wallet_id, reference) unique index.
 *
 * Offer sizing (deterministic, from score tier + 90d sales volume):
 *   tier A (score >= 800): cap 50% of 90d volume, fee  5%, term 30d, 20% of sales
 *   tier B (score >= 600): cap 30% of 90d volume, fee  7%, term 30d, 25% of sales
 *   tier C (score >= 400): cap 15% of 90d volume, fee  9%, term 21d, 30% of sales
 *   score < 400            : no offer
 * Principal is additionally clamped to [MIN_LOAN_CENTS, MAX_LOAN_CENTS].
 *
 * Outstanding-balance caps: at most ONE non-terminal loan per merchant
 * (active or disbursed blocks new offers — EXACTLY the partial unique index
 * 0088 set, so the lock-check and the index backstop cover the same rows),
 * and principal may never exceed MAX_LOAN_CENTS. Late/default: the sweep
 * marks loans past dueAt + DEFAULT_GRACE_DAYS as 'defaulted' (manual
 * repayments remain possible).
 */
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import {
  creditFacilities,
  merchantLoanFunding,
  merchantLoanRepayments,
  merchantLoans,
  merchantWallets,
  walletTransactions,
  type CreditFacility,
  type MerchantLoan,
} from "../../../drizzle/schema";
import { minorUnitsToString, toMinorUnitsExact } from "../../../shared/escrowAmounts";
import { getMerchantScore } from "../creditScore";
import { getDb } from "../../db";
import { ledgerBridgeRequest, LedgerBridgeError } from "../ledgerBridge";
import type { DbHandle, TxHandle } from "./accounts";

// ── Constants (deterministic; tunable only via code, documented above) ──────
export const MIN_LOAN_CENTS = 100_000;        // ₦1,000
export const MAX_LOAN_CENTS = 50_000_000;     // ₦500,000
export const DEFAULT_GRACE_DAYS = 7;

export interface LoanTier {
  tier: "A" | "B" | "C";
  minScore: number;
  /** Cap as integer percent of 90d sales volume. */
  volumeCapPct: number;
  feePct: number;
  termDays: number;
  repaymentPct: number;
}

export const LOAN_TIERS: readonly LoanTier[] = [
  { tier: "A", minScore: 800, volumeCapPct: 50, feePct: 5, termDays: 30, repaymentPct: 20 },
  { tier: "B", minScore: 600, volumeCapPct: 30, feePct: 7, termDays: 30, repaymentPct: 25 },
  { tier: "C", minScore: 400, volumeCapPct: 15, feePct: 9, termDays: 21, repaymentPct: 30 },
];

export function tierForScore(score: number): LoanTier | null {
  for (const t of LOAN_TIERS) if (score >= t.minScore) return t;
  return null;
}

export interface LoanOffer {
  tier: "A" | "B" | "C";
  maxPrincipalCents: number;
  feeCents: number;          // fee on maxPrincipalCents
  feePct: number;
  termDays: number;
  repaymentPct: number;
  totalRepayCents: number;
}

/** Pure offer sizing — unit-testable, integer math. */
export function sizeOffer(tier: LoanTier, salesVolumeCents90d: number): LoanOffer | null {
  const raw = Math.floor((salesVolumeCents90d * tier.volumeCapPct) / 100);
  const maxPrincipal = Math.max(0, Math.min(raw, MAX_LOAN_CENTS));
  if (maxPrincipal < MIN_LOAN_CENTS) return null;
  const feeCents = Math.round((maxPrincipal * tier.feePct) / 100);
  return {
    tier: tier.tier,
    maxPrincipalCents: maxPrincipal,
    feeCents,
    feePct: tier.feePct,
    termDays: tier.termDays,
    repaymentPct: tier.repaymentPct,
    totalRepayCents: maxPrincipal + feeCents,
  };
}

/** Pure per-sale deduction: pct of the sale, never more than outstanding. */
export function deductionForSale(saleCents: number, repaymentPct: number, outstandingCents: number): number {
  if (saleCents <= 0 || outstandingCents <= 0) return 0;
  return Math.min(Math.floor((saleCents * repaymentPct) / 100), outstandingCents);
}

export function loanRepaymentRef(loanId: string, walletTxId: string): string {
  return `loanrepay:${loanId}:${walletTxId}`.slice(0, 160);
}

async function requireDb(): Promise<DbHandle> {
  const db = await getDb();
  if (!db) throw new Error("[microLoans] database unavailable");
  return db;
}

// ── Offers ──────────────────────────────────────────────────────────────────

export interface OffersResult {
  score: number;
  computedAt: Date;
  offers: LoanOffer[];
  /** Why there are no offers, when offers is empty. */
  blockedReason: "score_below_minimum" | "insufficient_volume" | "existing_loan" | null;
  activeLoan: MerchantLoan | null;
}

export async function getLoanOffersTx(
  db: DbHandle,
  tenantId: string,
  merchantId: string,
  opts?: { now?: Date; trustScore?: number | null },
): Promise<OffersResult> {
  const { score, factors, computedAt } = await getMerchantScore(tenantId, merchantId, db, {
    now: opts?.now, trustScore: opts?.trustScore,
  });

  const open = await db
    .select()
    .from(merchantLoans)
    .where(and(
      eq(merchantLoans.tenantId, tenantId),
      eq(merchantLoans.merchantId, merchantId),
      inArray(merchantLoans.status, ["active", "disbursed", "defaulted"]),
    ))
    .limit(1);
  const activeLoan = open[0] ?? null;
  if (activeLoan) {
    return { score, computedAt, offers: [], blockedReason: "existing_loan", activeLoan };
  }

  const tier = tierForScore(score);
  if (!tier) {
    return { score, computedAt, offers: [], blockedReason: "score_below_minimum", activeLoan: null };
  }
  const offer = sizeOffer(tier, factors.salesVolumeCents90d);
  if (!offer) {
    return { score, computedAt, offers: [], blockedReason: "insufficient_volume", activeLoan: null };
  }
  return { score, computedAt, offers: [offer], blockedReason: null, activeLoan: null };
}

export async function getLoanOffers(
  tenantId: string,
  merchantId: string,
  opts?: { now?: Date; trustScore?: number | null },
): Promise<OffersResult> {
  return getLoanOffersTx(await requireDb(), tenantId, merchantId, opts);
}

// ── Accept + disburse ───────────────────────────────────────────────────────

export type AcceptLoanResult =
  | { ok: true; loan: MerchantLoan; walletTxId: string; deduped?: boolean }
  | { ok: false; reason: "existing_loan" | "no_offer" | "principal_exceeds_offer" | "wallet_unavailable" | "insufficient_funding" };

/** Deterministic TigerBeetle idempotency reference for the funding leg. */
export function loanFundingRef(loanId: string): string {
  return `loanfund:${loanId}`.slice(0, 64);
}

/** Postgres unique-violation on the open-loan partial index (0088)? */
function isOpenLoanUniqueViolation(err: any): boolean {
  const seen = new Set<any>();
  let cur: any = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (String(cur.code ?? "") === "23505") {
      const where = `${cur.constraint ?? ""} ${cur.constraint_name ?? ""} ${cur.message ?? ""}`;
      if (where.includes("merchant_loans_open_uniq")) return true;
    }
    cur = cur.cause;
  }
  return false;
}

/**
 * Accept an offer: creates the loan and disburses the principal to the
 * merchant wallet (availableBalance += principal, wallet tx
 * 'loan_disbursement' with reference `loandisb:<loanId>` — exactly-once).
 * The fee is NOT disbursed; outstanding = principal + fee.
 */
export async function acceptLoanTx(
  db: DbHandle,
  args: {
    tenantId: string;
    merchantId: string;
    principalCents: number;
    now?: Date;
    trustScore?: number | null;
  },
): Promise<AcceptLoanResult> {
  const now = args.now ?? new Date();
  const offersRes = await getLoanOffersTx(db, args.tenantId, args.merchantId, {
    now, trustScore: args.trustScore,
  });
  if (offersRes.activeLoan) return { ok: false, reason: "existing_loan" };
  const offer = offersRes.offers[0];
  if (!offer) return { ok: false, reason: "no_offer" };
  if (
    !Number.isSafeInteger(args.principalCents) ||
    args.principalCents < MIN_LOAN_CENTS ||
    args.principalCents > offer.maxPrincipalCents
  ) {
    return { ok: false, reason: "principal_exceeds_offer" };
  }

  const feeCents = Math.round((args.principalCents * offer.feePct) / 100);
  const outstandingCents = args.principalCents + feeCents;
  const dueAt = new Date(now.getTime() + offer.termDays * 24 * 3600 * 1000);

  // W30 (verify-v1 #3 + #12): the whole disbursement is ONE transaction,
  // serialized per-merchant by a FOR UPDATE lock on the merchant wallet row
  // (find-or-create first so there is always a row to lock) and backstopped
  // by the partial unique index merchant_loans_open_uniq (0088). The
  // existing-loan check is RE-RUN inside the lock; a loser that still races
  // the index (23505) is translated below into an idempotent return of the
  // existing loan. The funding leg decrements a lender facility atomically
  // and posts the TigerBeetle transfer BEFORE the wallet credit — no more
  // unbacked minted balance; insufficient commitment rejects honestly.
  let result: AcceptLoanResult;
  try {
    result = await db.transaction(async (tx) => {
      // Wallet rails: find-or-create the merchant wallet, then LOCK the row.
      await tx
        .insert(merchantWallets)
        .values({ tenantId: args.merchantId })
        .onConflictDoNothing();
      const [wallet] = await tx
        .select()
        .from(merchantWallets)
        .where(eq(merchantWallets.tenantId, args.merchantId))
        .limit(1)
        .for("update");
      if (!wallet) return { ok: false as const, reason: "wallet_unavailable" as const };

      // In-lock re-check: one open loan per merchant (the check above the tx
      // is only an offer-sizing read; THIS is the race-safe verdict).
      const [openLoan] = await tx
        .select()
        .from(merchantLoans)
        .where(and(
          eq(merchantLoans.tenantId, args.tenantId),
          eq(merchantLoans.merchantId, args.merchantId),
          // W30 hotfix: the blocking set is EXACTLY the partial unique
          // index set as widened by 0099 (active, disbursed, defaulted) so this in-lock re-check and
          // the index backstop cover the same rows (previously "defaulted"
          // was checked here but not indexed, and "disbursed" was indexed
          // but not checked — a disbursed-state loser re-threw instead of
          // idempotent return).
          inArray(merchantLoans.status, ["active", "disbursed", "defaulted"]),
        ))
        .limit(1);
      if (openLoan) return { ok: false as const, reason: "existing_loan" as const };

      // ── Funding leg (verify-v1 #12): lock + atomically decrement a lender
      // wholesale facility. Deterministic pick: oldest active facility with
      // sufficient remaining commitment.
      const [facility] = await tx
        .select()
        .from(creditFacilities)
        .where(and(
          eq(creditFacilities.status, "active"),
          gte(creditFacilities.commitmentCents, args.principalCents),
        ))
        .orderBy(asc(creditFacilities.createdAt), asc(creditFacilities.id))
        .limit(1)
        .for("update");
      if (!facility) return { ok: false as const, reason: "insufficient_funding" as const };
      const [funded] = await tx
        .update(creditFacilities)
        .set({
          commitmentCents: sql`${creditFacilities.commitmentCents} - ${args.principalCents}`,
          updatedAt: now,
        })
        .where(and(
          eq(creditFacilities.id, facility.id),
          gte(creditFacilities.commitmentCents, args.principalCents),
        ))
        .returning();
      if (!funded) return { ok: false as const, reason: "insufficient_funding" as const };

      const [loan] = await tx
        .insert(merchantLoans)
        .values({
          tenantId: args.tenantId,
          merchantId: args.merchantId,
          status: "active",
          principalCents: args.principalCents,
          feeCents,
          outstandingCents,
          repaymentPct: offer.repaymentPct,
          scoreAtAccept: offersRes.score,
          tier: offer.tier,
          disbursedAt: now,
          dueAt,
        })
        .returning();

      // Durable funding-leg record + TigerBeetle entry (escrow.ts:301-318
      // pattern: ledger BEFORE wallet credit; a bridge failure throws and
      // rolls the whole disbursement back — honest, nothing moved).
      const ledgerRef = loanFundingRef(loan.id);
      await tx.insert(merchantLoanFunding).values({
        loanId: loan.id,
        tenantId: args.tenantId,
        facilityId: facility.id,
        principalCents: args.principalCents,
        ledgerRef,
      });
      await postLoanFundingTransfer(facility, wallet.id, args.principalCents, ledgerRef);

      const beforeCents = toMinorUnitsExact(wallet.availableBalance);
      const afterCents = beforeCents + args.principalCents;
      const [wtx] = await tx
        .insert(walletTransactions)
        .values({
          walletId: wallet.id,
          tenantId: args.tenantId,
          type: "loan_disbursement",
          amount: minorUnitsToString(args.principalCents),
          balanceBefore: minorUnitsToString(beforeCents),
          balanceAfter: minorUnitsToString(afterCents),
          currency: wallet.currency,
          description: `Micro-loan disbursement (tier ${offer.tier}, loan ${loan.id})`,
          reference: `loandisb:${loan.id}`,
          metadata: { loanId: loan.id, tier: offer.tier, scoreAtAccept: offersRes.score, facilityId: facility.id },
        })
        .returning();
      await tx
        .update(merchantWallets)
        .set({
          availableBalance: minorUnitsToString(afterCents),
          updatedAt: now,
        })
        .where(eq(merchantWallets.id, wallet.id));
      const [updated] = await tx
        .update(merchantLoans)
        .set({ walletTxId: wtx.id, updatedAt: now })
        .where(eq(merchantLoans.id, loan.id))
        .returning();
      return { ok: true as const, loan: updated, walletTxId: wtx.id };
    });
  } catch (err: any) {
    // 23505 on merchant_loans_open_uniq: a concurrent accept won the insert
    // race — the disbursement above rolled back (no wallet credit, no
    // facility decrement, no funding row). Return the winner's loan.
    if (isOpenLoanUniqueViolation(err)) {
      const [existing] = await db
        .select()
        .from(merchantLoans)
        .where(and(
          eq(merchantLoans.tenantId, args.tenantId),
          eq(merchantLoans.merchantId, args.merchantId),
          inArray(merchantLoans.status, ["active", "disbursed", "defaulted"]),
        ))
        .limit(1);
      if (existing) {
        return { ok: true, loan: existing, walletTxId: existing.walletTxId ?? "", deduped: true };
      }
    }
    throw err;
  }
  return result;
}

/**
 * Post the double-entry funding leg to the ledger bridge (integer cents,
 * deterministic idempotency key `loanfund:<loanId>`). A 400/409 means the
 * transfer is already recorded for this key (idempotent replay) — a no-op,
 * NOT an error. Unreachable/5xx throws: the disbursement transaction rolls
 * back so no unbacked balance is ever minted.
 */
async function postLoanFundingTransfer(
  facility: Pick<CreditFacility, "id">,
  walletId: string,
  principalCents: number,
  ledgerRef: string,
): Promise<void> {
  try {
    await ledgerBridgeRequest("/transfer", "POST", {
      debit_account_id: `credit-facility:${facility.id}`,
      credit_account_id: `merchant-wallet:${walletId}`,
      amount: principalCents,
      ledger: 1,
      code: 1,
      idempotency_key: ledgerRef,
    });
  } catch (err: any) {
    if (err instanceof LedgerBridgeError && err.status != null && [400, 409].includes(err.status)) {
      return; // already posted under this idempotency key
    }
    throw err;
  }
}

export async function acceptLoan(args: {
  tenantId: string;
  merchantId: string;
  principalCents: number;
  now?: Date;
  trustScore?: number | null;
}): Promise<AcceptLoanResult> {
  return acceptLoanTx(await requireDb(), args);
}

// ── Repayment application (shared by sweep + manual repayments) ─────────────

/**
 * W30 (verify-v1 #4): the ONE locked repayment helper shared by the sweep
 * and manual repayments. Race-hardened:
 *   1. The loan row is re-read FOR UPDATE inside the tx — every repayment
 *      serializes on it and computes from the FRESH outstanding.
 *   2. The wallet row is locked FOR UPDATE before the debit.
 *   3. The debit is a CONDITIONAL DECREMENT (`available_balance >= debit`),
 *      never an absolute SET from a stale read.
 *   4. The loan outstanding is a guarded decrement in the SAME transaction
 *      (`outstanding_cents >= debit`, GREATEST-clamped) — ledger, balance
 *      and outstanding can never diverge.
 */
async function applyRepaymentAmountTx(
  tx: TxHandle,
  loanId: string,
  amountCents: number,
  meta: { source: "sale_deduction" | "manual"; reference: string; orderId?: string | null; saleWalletTxId?: string | null },
  now: Date,
): Promise<{ ok: boolean; outstandingAfter: number; repaid: boolean }> {
  // (1) Lock the loan row — serializes sweep vs manual on the fresh state.
  const [loan] = await tx
    .select()
    .from(merchantLoans)
    .where(eq(merchantLoans.id, loanId))
    .limit(1)
    .for("update");
  if (!loan) return { ok: false, outstandingAfter: 0, repaid: false };
  if (amountCents <= 0) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: loan.outstandingCents === 0 };

  // Idempotency: a recorded repayment reference means this deduction ran.
  const dup = await tx
    .select({ id: merchantLoanRepayments.id })
    .from(merchantLoanRepayments)
    .where(eq(merchantLoanRepayments.reference, meta.reference))
    .limit(1);
  if (dup.length > 0) {
    return { ok: false, outstandingAfter: loan.outstandingCents, repaid: loan.outstandingCents === 0 };
  }

  // (2) Lock the wallet row before reading the balance.
  const [wallet] = await tx
    .select()
    .from(merchantWallets)
    .where(eq(merchantWallets.tenantId, loan.merchantId))
    .limit(1)
    .for("update");
  if (!wallet) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: false };

  const availCents = toMinorUnitsExact(wallet.availableBalance);
  const debit = Math.min(amountCents, availCents, loan.outstandingCents);
  if (debit <= 0) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: loan.outstandingCents === 0 };

  // (3) Conditional decrement — the guard, not a stale read, decides.
  const [debited] = await tx
    .update(merchantWallets)
    .set({
      availableBalance: sql`${merchantWallets.availableBalance} - ${minorUnitsToString(debit)}`,
      updatedAt: now,
    })
    .where(and(
      eq(merchantWallets.id, wallet.id),
      sql`${merchantWallets.availableBalance} >= ${minorUnitsToString(debit)}`,
    ))
    .returning();
  if (!debited) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: false };
  const afterCents = toMinorUnitsExact(debited.availableBalance);
  const beforeCents = afterCents + debit;

  const [wtx] = await tx
    .insert(walletTransactions)
    .values({
      walletId: wallet.id,
      tenantId: loan.tenantId,
      type: "loan_repayment",
      amount: minorUnitsToString(debit),
      balanceBefore: minorUnitsToString(beforeCents),
      balanceAfter: minorUnitsToString(afterCents),
      currency: wallet.currency,
      orderId: meta.orderId ?? null,
      description: `Micro-loan repayment (${meta.source}, loan ${loan.id})`,
      reference: meta.reference,
      metadata: { loanId: loan.id, source: meta.source, saleWalletTxId: meta.saleWalletTxId ?? null },
    })
    .returning();

  await tx.insert(merchantLoanRepayments).values({
    loanId: loan.id,
    tenantId: loan.tenantId,
    amountCents: debit,
    source: meta.source,
    orderId: meta.orderId ?? null,
    walletTxId: wtx.id,
    reference: meta.reference,
  });

  // (4) Guarded outstanding decrement in the same transaction.
  const [updatedLoan] = await tx
    .update(merchantLoans)
    .set({
      outstandingCents: sql`GREATEST(0, ${merchantLoans.outstandingCents} - ${debit})`,
      updatedAt: now,
    })
    .where(and(
      eq(merchantLoans.id, loan.id),
      sql`${merchantLoans.outstandingCents} >= ${debit}`,
    ))
    .returning();
  if (!updatedLoan) {
    // Cannot happen while the loan row lock is held (debit <= outstanding),
    // but fail honestly rather than diverge the ledger.
    throw new Error(`[microLoans] outstanding guard refused repayment for loan ${loan.id}`);
  }
  const outstandingAfter = updatedLoan.outstandingCents;
  const repaid = outstandingAfter === 0;
  if (repaid) {
    await tx
      .update(merchantLoans)
      .set({ status: "repaid" as const, repaidAt: now, updatedAt: now })
      .where(and(eq(merchantLoans.id, loan.id), eq(merchantLoans.outstandingCents, 0)));
  }
  return { ok: true, outstandingAfter, repaid };
}

/** Merchant-initiated manual repayment (e.g. portal "repay now"). */
export async function repayLoanManualTx(
  db: DbHandle,
  args: { loanId: string; amountCents: number; now?: Date },
): Promise<{ ok: boolean; outstandingAfter: number; repaid: boolean }> {
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const [loan] = await tx.select().from(merchantLoans).where(eq(merchantLoans.id, args.loanId)).limit(1);
    if (!loan || (loan.status !== "active" && loan.status !== "defaulted")) {
      return { ok: false, outstandingAfter: loan?.outstandingCents ?? 0, repaid: false };
    }
    const amount = Math.min(args.amountCents, loan.outstandingCents);
    // Deterministic once the loan+wallet locks are held (W30): a retry with
    // the same timestamp is deduped by merchant_loan_repayments_ref_uniq; a
    // concurrent sweep serializes on the loan row lock inside the helper.
    return applyRepaymentAmountTx(tx, loan.id, amount, {
      source: "manual",
      reference: `loanmanual:${loan.id}:${now.getTime()}:${amount}`.slice(0, 160),
    }, now);
  });
}

// ── Sweep: auto-deduct from settled sales + late/default handling ───────────

export interface LoanSweepResult {
  scanned: number;      // active/defaulted loans considered
  deductions: number;   // sale deductions applied
  deductedCents: number;
  markedDefaulted: number;
  repaidLoans: number;
}

/**
 * Auto-repayment sweep. For every ACTIVE loan, scans the merchant wallet's
 * 'escrow_release' credits since the loan disbursal and deducts
 * repaymentPct of each not-yet-deducted sale (idempotent via reference).
 * Then marks loans past dueAt + DEFAULT_GRACE_DAYS with outstanding > 0 as
 * 'defaulted'. Append-only cron-style job — safe to run repeatedly.
 */
export async function runLoanRepaymentSweepTx(
  db: DbHandle,
  opts?: { now?: Date },
): Promise<LoanSweepResult> {
  const now = opts?.now ?? new Date();
  const result: LoanSweepResult = { scanned: 0, deductions: 0, deductedCents: 0, markedDefaulted: 0, repaidLoans: 0 };

  const openLoans = await db
    .select()
    .from(merchantLoans)
    .where(inArray(merchantLoans.status, ["active", "defaulted"]));
  result.scanned = openLoans.length;

  for (const loan of openLoans) {
    if (loan.status === "active") {
      // Settled-sale credits not yet swept: escrow_release wallet txs after
      // disbursal. (COD/manual sales settle outside the wallet; the sweep
      // hooks the wallet rails per spec.)
      const credits = await db
        .select()
        .from(walletTransactions)
        .where(and(
          eq(walletTransactions.tenantId, loan.tenantId),
          eq(walletTransactions.type, "escrow_release"),
          loan.disbursedAt ? gt(walletTransactions.createdAt, loan.disbursedAt) : sql`true`,
        ))
        .orderBy(walletTransactions.createdAt);

      for (const credit of credits) {
        // Re-read the freshest loan state each iteration.
        const [fresh] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, loan.id)).limit(1);
        if (!fresh || fresh.status !== "active" || fresh.outstandingCents <= 0) break;
        const saleCents = toMinorUnitsExact(credit.amount);
        const deduction = deductionForSale(saleCents, fresh.repaymentPct, fresh.outstandingCents);
        const ref = loanRepaymentRef(fresh.id, credit.id);
        const applied = await db.transaction(async (tx) =>
          applyRepaymentAmountTx(tx, fresh.id, deduction, {
            source: "sale_deduction",
            reference: ref,
            orderId: credit.orderId ?? null,
            saleWalletTxId: credit.id,
          }, now),
        );
        if (applied.ok) {
          result.deductions += 1;
          result.deductedCents += Math.min(deduction, fresh.outstandingCents);
          if (applied.repaid) result.repaidLoans += 1;
        }
      }
    }

    // Late/default handling (also runs for already-defaulted loans so the
    // timestamp is stable — defaultedAt is only stamped on transition).
    const [cur] = await db.select().from(merchantLoans).where(eq(merchantLoans.id, loan.id)).limit(1);
    if (
      cur && cur.status === "active" && cur.dueAt &&
      now.getTime() > cur.dueAt.getTime() + DEFAULT_GRACE_DAYS * 24 * 3600 * 1000 &&
      cur.outstandingCents > 0
    ) {
      await db
        .update(merchantLoans)
        .set({ status: "defaulted", defaultedAt: now, updatedAt: now })
        .where(and(eq(merchantLoans.id, cur.id), eq(merchantLoans.status, "active")));
      result.markedDefaulted += 1;
    }
  }
  return result;
}

export async function runLoanRepaymentSweep(now?: Date): Promise<LoanSweepResult> {
  return runLoanRepaymentSweepTx(await requireDb(), { now });
}

// ── Read helpers (router / portal / WhatsApp) ───────────────────────────────

export async function listLoansTx(
  db: DbHandle,
  tenantId: string,
  merchantId: string,
): Promise<MerchantLoan[]> {
  return db
    .select()
    .from(merchantLoans)
    .where(and(eq(merchantLoans.tenantId, tenantId), eq(merchantLoans.merchantId, merchantId)))
    .orderBy(desc(merchantLoans.createdAt));
}

export interface RepaymentScheduleEntry {
  kind: "per_sale" | "due_date";
  label: string;
  amountCents: number | null;
  at: Date | null;
}

/** Deterministic derived schedule: pct-of-sale rule + final due date. */
export function repaymentScheduleFor(loan: MerchantLoan): RepaymentScheduleEntry[] {
  return [
    {
      kind: "per_sale",
      label: `${loan.repaymentPct}% of every settled sale is auto-deducted`,
      amountCents: null,
      at: null,
    },
    {
      kind: "due_date",
      label: loan.outstandingCents > 0 ? "Outstanding balance due" : "Fully repaid",
      amountCents: loan.outstandingCents,
      at: loan.dueAt ?? null,
    },
  ];
}
