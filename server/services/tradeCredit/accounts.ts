/**
 * Trade credit accounts — lifecycle and read helpers.
 *
 * A credit_account is the (supplierTenantId, buyerTenantId) facility a
 * supplier extends to a buyer for B2B procurement on credit. Money movement
 * (draws / repayments) lives in draw.ts / repayment.ts; this module owns
 * account creation, limit/terms administration, freeze/unfreeze/close and
 * the read paths (single account, aging-bucket lists, ledger lists).
 *
 * All functions take the caller's db/tx handle (repo convention, see
 * services/inventory.ts) so multi-statement flows run in ONE transaction.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  creditAccounts,
  creditLedger,
  type CreditAccount,
  type CreditLedgerEntry,
} from "../../../drizzle/schema";
import { reportEvent } from "../compliance/bureau";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle mutation/query surface (db or tx). */
export type TxHandle = Pick<DbHandle, "select" | "insert" | "update" | "execute" | "transaction">;

export type CreditAccountStatus = "pending" | "active" | "frozen" | "closed";
export type CreditLedgerKind = "invoice_draw" | "repayment" | "fee" | "adjustment";

/**
 * W14: deterministic bureau-consent reference for an account (≤64 chars).
 * Stamped alongside bureau_consent_at when the buyer accepts the
 * bureau-reporting terms (see services/i18n BUREAU_CONSENT_TEXT).
 */
export function bureauConsentRef(accountId: string): string {
  return `bcr:${accountId}`.slice(0, 64);
}

export class CreditAccountExistsError extends Error {
  constructor(supplierTenantId: string, buyerTenantId: string) {
    super(`Credit account already exists for supplier=${supplierTenantId} buyer=${buyerTenantId}`);
    this.name = "CreditAccountExistsError";
  }
}

/** Fetch the account for a (supplier, buyer) pair, or null when none exists. */
export async function getCreditAccountTx(
  db: TxHandle,
  supplierTenantId: string,
  buyerTenantId: string,
): Promise<CreditAccount | null> {
  const [row] = await db
    .select()
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.supplierTenantId, supplierTenantId),
        eq(creditAccounts.buyerTenantId, buyerTenantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Fetch an account by primary key, or null. */
export async function getCreditAccountByIdTx(
  db: TxHandle,
  accountId: string,
): Promise<CreditAccount | null> {
  const [row] = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.id, accountId))
    .limit(1);
  return row ?? null;
}

/**
 * Create a credit facility. The UNIQUE(supplier, buyer) index is the
 * authoritative dedupe — duplicates surface as CreditAccountExistsError.
 */
export async function createCreditAccountTx(
  db: TxHandle,
  args: {
    supplierTenantId: string;
    buyerTenantId: string;
    limitCents: number;
    termsDays?: number;
    score?: number | null;
    scoreReasons?: string[] | null;
  },
): Promise<CreditAccount> {
  const existing = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
  if (existing) throw new CreditAccountExistsError(args.supplierTenantId, args.buyerTenantId);
  const [row] = await db
    .insert(creditAccounts)
    .values({
      supplierTenantId: args.supplierTenantId,
      buyerTenantId: args.buyerTenantId,
      limitCents: Math.max(0, Math.round(args.limitCents)),
      termsDays: args.termsDays ?? 30,
      score: args.score ?? null,
      scoreReasons: args.scoreReasons ?? null,
    })
    .returning();
  return row;
}

/**
 * Buyer-initiated facility request: creates the (supplier, buyer) account in
 * 'pending' status with a zero limit. A pending account is inert — the
 * drawOnCredit claim requires status='active' (draw.ts), so the buyer can
 * NEVER draw against it until the supplier approves. The supplier sees the
 * pending row in listAccounts and flips it active via approveCreditAccountTx
 * (setting limit/terms at the same time). Same UNIQUE-pair dedupe as
 * createCreditAccountTx — a repeat request (or an existing active facility)
 * surfaces CreditAccountExistsError.
 */
export async function requestCreditAccountTx(
  db: TxHandle,
  args: {
    supplierTenantId: string;
    buyerTenantId: string;
    /** W14: buyer accepted the bureau-reporting terms at request time. */
    bureauConsent?: boolean;
  },
): Promise<CreditAccount> {
  const existing = await getCreditAccountTx(db, args.supplierTenantId, args.buyerTenantId);
  if (existing) throw new CreditAccountExistsError(args.supplierTenantId, args.buyerTenantId);
  const [row] = await db
    .insert(creditAccounts)
    .values({
      supplierTenantId: args.supplierTenantId,
      buyerTenantId: args.buyerTenantId,
      limitCents: 0,
      status: "pending",
    })
    .returning();
  // W14: stamp consent post-insert (id derived only after insert). Plain
  // claim-first UPDATE on the row we just created — no race possible.
  if (args.bureauConsent === true && row) {
    const [stamped] = await db
      .update(creditAccounts)
      .set({ bureauConsentAt: new Date(), bureauConsentRef: bureauConsentRef(row.id), updatedAt: new Date() })
      .where(eq(creditAccounts.id, row.id))
      .returning();
    return stamped ?? row;
  }
  return row;
}

/**
 * Supplier approves a pending facility: claim-first UPDATE that only matches
 * when the account belongs to `supplierTenantId` AND is still 'pending'
 * (so double-approve / approve-after-close is a no-op returning null).
 * Optionally sets the limit and terms in the same statement.
 */
export async function approveCreditAccountTx(
  db: TxHandle,
  args: {
    accountId: string;
    supplierTenantId: string;
    limitCents?: number;
    termsDays?: number;
    /**
     * W14: the buyer accepted the bureau-reporting terms
     * (BUREAU_CONSENT_TEXT). Stamps bureau_consent_at/ref on approval.
     * NOT a hard gate — approval proceeds without it (Nigeria legal review
     * pending), but non-consented accounts are excluded from bureau
     * reporting (compliance/bureau.ts) and the router logs consent_missing.
     */
    bureauConsent?: boolean;
  },
): Promise<CreditAccount | null> {
  const set: Record<string, unknown> = { status: "active", updatedAt: new Date() };
  if (args.limitCents !== undefined) set.limitCents = Math.max(0, Math.round(args.limitCents));
  if (args.termsDays !== undefined) set.termsDays = args.termsDays;
  if (args.bureauConsent === true) {
    set.bureauConsentAt = new Date();
    set.bureauConsentRef = bureauConsentRef(args.accountId);
  }
  const [row] = await db
    .update(creditAccounts)
    .set(set)
    .where(
      and(
        eq(creditAccounts.id, args.accountId),
        eq(creditAccounts.supplierTenantId, args.supplierTenantId),
        eq(creditAccounts.status, "pending"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Update limit / terms. Claim-first on supplier ownership: the UPDATE only
 * matches when the account belongs to `supplierTenantId`, so a supplier can
 * never mutate another supplier's facility (defense-in-depth under the
 * router's assertTenantAccess).
 */
export async function updateCreditAccountTx(
  db: TxHandle,
  args: {
    accountId: string;
    supplierTenantId: string;
    limitCents?: number;
    termsDays?: number;
    score?: number | null;
    scoreReasons?: string[] | null;
  },
): Promise<CreditAccount | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (args.limitCents !== undefined) set.limitCents = Math.max(0, Math.round(args.limitCents));
  if (args.termsDays !== undefined) set.termsDays = args.termsDays;
  if (args.score !== undefined) set.score = args.score;
  if (args.scoreReasons !== undefined) set.scoreReasons = args.scoreReasons;
  const [row] = await db
    .update(creditAccounts)
    .set(set)
    .where(
      and(
        eq(creditAccounts.id, args.accountId),
        eq(creditAccounts.supplierTenantId, args.supplierTenantId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Set account status with claim-first ownership scoping. Valid transitions:
 *   active → frozen (dunning +7d or supplier action)
 *   frozen → active (supplier unfreeze after settlement)
 *   active|frozen → closed (terminal; no further draws)
 */
export async function setCreditAccountStatusTx(
  db: TxHandle,
  args: { accountId: string; supplierTenantId: string; status: CreditAccountStatus },
): Promise<CreditAccount | null> {
  const [row] = await db
    .update(creditAccounts)
    .set({ status: args.status, updatedAt: new Date() })
    .where(
      and(
        eq(creditAccounts.id, args.accountId),
        eq(creditAccounts.supplierTenantId, args.supplierTenantId),
      ),
    )
    .returning();
  // W14: bureau 'closure' event (fire-and-forget; reportEvent never throws
  // and skips non-consented accounts internally).
  if (row && args.status === "closed") {
    await reportEvent(db, {
      accountId: row.id,
      eventType: "closure",
      payload: {
        outstandingCents: row.outstandingCents,
        reason: "supplier_close",
        occurredAt: new Date().toISOString(),
      },
    });
  }
  return row ?? null;
}

// ── Aging buckets ────────────────────────────────────────────────────────────

export interface AgingBuckets {
  /** Not yet due (posted draws with due_date in the future or null). */
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  days90plus: number;
}

export interface CreditAccountWithAging extends CreditAccount {
  aging: AgingBuckets;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket a posted draw's unpaid amount by days overdue. Simplification
 * (documented): buckets are computed on POSTED draw amounts, not net of
 * partial repayments — repayments settle draws FIFO (repayment.ts), so a
 * posted draw is either wholly unpaid or the oldest partially-covered one;
 * aging on the full draw amount is the conservative (supplier-protective)
 * reading.
 */
export function bucketForDraw(dueDate: Date | null, now: Date): keyof AgingBuckets {
  if (!dueDate) return "current";
  const overdueDays = Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS);
  if (overdueDays <= 0) return "current";
  if (overdueDays <= 30) return "days1to30";
  if (overdueDays <= 60) return "days31to60";
  if (overdueDays <= 90) return "days61to90";
  return "days90plus";
}

/** Supplier-side portfolio list: every facility with aging buckets. */
export async function listCreditAccountsWithAgingTx(
  db: TxHandle,
  supplierTenantId: string,
  now: Date = new Date(),
): Promise<CreditAccountWithAging[]> {
  const accounts = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.supplierTenantId, supplierTenantId))
    .orderBy(asc(creditAccounts.createdAt));
  const out: CreditAccountWithAging[] = [];
  for (const account of accounts) {
    const draws = await db
      .select({ amountCents: creditLedger.amountCents, dueDate: creditLedger.dueDate })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.creditAccountId, account.id),
          eq(creditLedger.kind, "invoice_draw"),
          eq(creditLedger.status, "posted"),
        ),
      );
    const aging: AgingBuckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0 };
    for (const d of draws) {
      aging[bucketForDraw(d.dueDate ? new Date(d.dueDate) : null, now)] += d.amountCents;
    }
    out.push({ ...account, aging });
  }
  return out;
}

/** Ledger list for an account, newest first. */
export async function listLedgerTx(
  db: TxHandle,
  accountId: string,
  limit = 100,
): Promise<CreditLedgerEntry[]> {
  return db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.creditAccountId, accountId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(Math.min(Math.max(1, limit), 500));
}

/**
 * Buyer-side limit-increase request: a zero-amount 'adjustment' ledger note
 * (ref `limitreq:<ts>`) the supplier sees in the ledger list. Zero amount ⇒
 * no money-path impact; the supplier acts via updateCreditAccountTx.
 */
export async function requestLimitIncreaseTx(
  db: TxHandle,
  args: { accountId: string; requestedLimitCents: number; note?: string },
): Promise<CreditLedgerEntry> {
  const [row] = await db
    .insert(creditLedger)
    .values({
      creditAccountId: args.accountId,
      kind: "adjustment",
      amountCents: 0,
      ref: `limitreq:${Date.now()}`,
      note:
        `Limit increase requested: ${args.requestedLimitCents} cents` +
        (args.note ? ` — ${args.note.slice(0, 500)}` : ""),
    })
    .returning();
  return row;
}

/** Recompute outstanding from the ledger (reconciliation/audit helper). */
export async function ledgerOutstandingTx(db: TxHandle, accountId: string): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COALESCE(SUM(CASE WHEN kind IN ('invoice_draw','fee') THEN amount_cents
                             WHEN kind = 'repayment' THEN -amount_cents
                             ELSE 0 END), 0)::bigint AS outstanding
    FROM credit_ledger
    WHERE credit_account_id = ${accountId} AND status <> 'void'
  `);
  const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
  return Number(rows[0]?.outstanding ?? 0);
}
