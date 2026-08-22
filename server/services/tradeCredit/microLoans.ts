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
 * (active or defaulted blocks new offers), and principal may never exceed
 * MAX_LOAN_CENTS. Late/default: the sweep marks loans past
 * dueAt + DEFAULT_GRACE_DAYS as 'defaulted'; a defaulted loan blocks new
 * offers until fully repaid (manual repayments remain possible).
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  merchantLoanRepayments,
  merchantLoans,
  merchantWallets,
  walletTransactions,
  type MerchantLoan,
} from "../../../drizzle/schema";
import { minorUnitsToString, toMinorUnitsExact } from "../../../shared/escrowAmounts";
import { getMerchantScore } from "../creditScore";
import { getDb } from "../../db";
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
      inArray(merchantLoans.status, ["active", "defaulted"]),
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
  | { ok: true; loan: MerchantLoan; walletTxId: string }
  | { ok: false; reason: "existing_loan" | "no_offer" | "principal_exceeds_offer" | "wallet_unavailable" };

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

  return db.transaction(async (tx) => {
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

    // Wallet rails: find-or-create the merchant wallet, then credit.
    let [wallet] = await tx
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.tenantId, args.merchantId))
      .limit(1);
    if (!wallet) {
      [wallet] = await tx
        .insert(merchantWallets)
        .values({ tenantId: args.merchantId })
        .returning();
    }
    if (!wallet) return { ok: false as const, reason: "wallet_unavailable" as const };

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
        metadata: { loanId: loan.id, tier: offer.tier, scoreAtAccept: offersRes.score },
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

async function applyRepaymentAmountTx(
  tx: TxHandle,
  loan: MerchantLoan,
  amountCents: number,
  meta: { source: "sale_deduction" | "manual"; reference: string; orderId?: string | null; saleWalletTxId?: string | null },
  now: Date,
): Promise<{ ok: boolean; outstandingAfter: number; repaid: boolean }> {
  if (amountCents <= 0) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: false };

  // Idempotency: a recorded repayment reference means this deduction ran.
  const dup = await tx
    .select({ id: merchantLoanRepayments.id })
    .from(merchantLoanRepayments)
    .where(eq(merchantLoanRepayments.reference, meta.reference))
    .limit(1);
  if (dup.length > 0) {
    return { ok: false, outstandingAfter: loan.outstandingCents, repaid: loan.outstandingCents === 0 };
  }

  const [wallet] = await tx
    .select()
    .from(merchantWallets)
    .where(eq(merchantWallets.tenantId, loan.merchantId))
    .limit(1);
  if (!wallet) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: false };

  const availCents = toMinorUnitsExact(wallet.availableBalance);
  const debit = Math.min(amountCents, availCents);
  if (debit <= 0) return { ok: false, outstandingAfter: loan.outstandingCents, repaid: false };
  const afterCents = availCents - debit;

  const [wtx] = await tx
    .insert(walletTransactions)
    .values({
      walletId: wallet.id,
      tenantId: loan.tenantId,
      type: "loan_repayment",
      amount: minorUnitsToString(debit),
      balanceBefore: minorUnitsToString(availCents),
      balanceAfter: minorUnitsToString(afterCents),
      currency: wallet.currency,
      orderId: meta.orderId ?? null,
      description: `Micro-loan repayment (${meta.source}, loan ${loan.id})`,
      reference: meta.reference,
      metadata: { loanId: loan.id, source: meta.source, saleWalletTxId: meta.saleWalletTxId ?? null },
    })
    .returning();
  await tx
    .update(merchantWallets)
    .set({ availableBalance: minorUnitsToString(afterCents), updatedAt: now })
    .where(eq(merchantWallets.id, wallet.id));

  await tx.insert(merchantLoanRepayments).values({
    loanId: loan.id,
    tenantId: loan.tenantId,
    amountCents: debit,
    source: meta.source,
    orderId: meta.orderId ?? null,
    walletTxId: wtx.id,
    reference: meta.reference,
  });

  const outstandingAfter = Math.max(0, loan.outstandingCents - debit);
  const repaid = outstandingAfter === 0;
  await tx
    .update(merchantLoans)
    .set({
      outstandingCents: outstandingAfter,
      ...(repaid ? { status: "repaid" as const, repaidAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(merchantLoans.id, loan.id));
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
    return applyRepaymentAmountTx(tx, loan, amount, {
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
          applyRepaymentAmountTx(tx, fresh, deduction, {
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
