/**
 * W14 F4 — loan-book tape export for lenders.
 *
 * generateLoanBookTape produces one row per credit account (optionally
 * restricted to a facility), a book summary, and a CSV rendering. The tape
 * is what a lender receives monthly to monitor the collateralized book:
 * per-account limit/outstanding/score, days-past-due aging bucket, bureau
 * consent flag, repayment-mandate status, and the facility the account is
 * assigned to.
 *
 * The heavy lifting is pure (buildTape / summarizeTape / tapeToCsv) so the
 * math is testable without a db; the db-facing wrapper only fetches rows.
 */
import { eq, and, inArray } from "drizzle-orm";
import { creditLedger, paymentMandates } from "../../../drizzle/schema";
import { creditAccountsExt, creditFacilities, type CreditAccountExt } from "./tables";
import { FacilityNotFoundError, getFacilityById, type TxHandle } from "./facilities";

export type DpdBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface TapeRow {
  accountId: string;
  buyerTenantId: string;
  supplierTenantId: string;
  limitCents: number;
  outstandingCents: number;
  score: number | null;
  /** Days past due on the oldest unpaid draw (0 when nothing is overdue). */
  dpd: number;
  bucket: DpdBucket;
  /** True when the buyer has granted bureau-reporting consent (0051 col). */
  bureauConsent: boolean;
  /** Linked repayment-mandate status, or 'none' when unlinked. */
  mandateStatus: string;
  /** Facility ref the account is assigned to, or null when unassigned. */
  facilityRef: string | null;
}

export interface TapeSummary {
  accountCount: number;
  totalOutstandingCents: number;
  /** Outstanding-weighted average score over scored accounts; null if none. */
  weightedScore: number | null;
  /** Share of total outstanding sitting in the 90+ bucket (0..1). */
  nplRatio: number;
}

export interface LoanBookTape {
  asOf: string; // ISO
  facilityRef: string | null;
  rows: TapeRow[];
  summary: TapeSummary;
  csv: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Aging bucket for a days-past-due count. Boundaries are inclusive-lower. */
export function bucketForDpd(dpd: number): DpdBucket {
  if (dpd <= 0) return "current";
  if (dpd <= 30) return "1-30";
  if (dpd <= 60) return "31-60";
  if (dpd <= 90) return "61-90";
  return "90+";
}

/**
 * Pure tape construction. `dueDatesByAccount` maps account id → due dates of
 * its still-posted draws; dpd is measured from the OLDEST past-due date.
 */
export function buildTapeRows(args: {
  accounts: Array<
    Pick<
      CreditAccountExt,
      | "id"
      | "buyerTenantId"
      | "supplierTenantId"
      | "limitCents"
      | "outstandingCents"
      | "score"
      | "mandateId"
      | "bureauConsentAt"
      | "facilityId"
    >
  >;
  dueDatesByAccount: Map<string, Date[]>;
  mandateStatusById: Map<string, string>;
  facilityRefById: Map<string, string>;
  asOf: Date;
}): TapeRow[] {
  const { accounts, dueDatesByAccount, mandateStatusById, facilityRefById, asOf } = args;
  const rows: TapeRow[] = [];
  for (const a of accounts) {
    let dpd = 0;
    for (const due of dueDatesByAccount.get(a.id) ?? []) {
      const days = Math.floor((asOf.getTime() - due.getTime()) / DAY_MS);
      if (days > dpd) dpd = days;
    }
    rows.push({
      accountId: a.id,
      buyerTenantId: a.buyerTenantId,
      supplierTenantId: a.supplierTenantId,
      limitCents: a.limitCents,
      outstandingCents: a.outstandingCents,
      score: a.score ?? null,
      dpd,
      bucket: bucketForDpd(dpd),
      bureauConsent: a.bureauConsentAt != null,
      mandateStatus: a.mandateId ? (mandateStatusById.get(a.mandateId) ?? "unknown") : "none",
      facilityRef: a.facilityId ? (facilityRefById.get(a.facilityId) ?? null) : null,
    });
  }
  // Deterministic order: worst delinquency first, then largest exposure.
  rows.sort((x, y) => y.dpd - x.dpd || y.outstandingCents - x.outstandingCents || (x.accountId < y.accountId ? -1 : 1));
  return rows;
}

/** Pure summary: exposure-weighted score and 90+ NPL share. */
export function summarizeTape(rows: TapeRow[]): TapeSummary {
  const totalOutstandingCents = rows.reduce((s, r) => s + r.outstandingCents, 0);
  let scoredOutstanding = 0;
  let scoreWeightSum = 0;
  let nplOutstanding = 0;
  for (const r of rows) {
    if (r.score != null && r.outstandingCents > 0) {
      scoredOutstanding += r.outstandingCents;
      scoreWeightSum += r.score * r.outstandingCents;
    }
    if (r.bucket === "90+") nplOutstanding += r.outstandingCents;
  }
  return {
    accountCount: rows.length,
    totalOutstandingCents,
    weightedScore: scoredOutstanding > 0 ? Math.round((scoreWeightSum / scoredOutstanding) * 100) / 100 : null,
    nplRatio: totalOutstandingCents > 0 ? nplOutstanding / totalOutstandingCents : 0,
  };
}

function csvCell(v: string | number | boolean | null): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const TAPE_CSV_HEADER =
  "accountId,buyerTenantId,supplierTenantId,limitCents,outstandingCents,score,dpd,bucket,bureauConsent,mandateStatus,facilityRef";

/** CSV rendering of tape rows (header + one line per row, CRLF-free). */
export function tapeToCsv(rows: TapeRow[]): string {
  const lines = rows.map((r) =>
    [
      r.accountId,
      r.buyerTenantId,
      r.supplierTenantId,
      r.limitCents,
      r.outstandingCents,
      r.score,
      r.dpd,
      r.bucket,
      r.bureauConsent,
      r.mandateStatus,
      r.facilityRef,
    ]
      .map(csvCell)
      .join(","),
  );
  return [TAPE_CSV_HEADER, ...lines].join("\n") + "\n";
}

/**
 * Generate the loan-book tape. With `facilityId`, only accounts assigned to
 * that facility are included; otherwise the whole book.
 */
export async function generateLoanBookTape(
  db: TxHandle,
  args: { facilityId?: string; asOf?: Date } = {},
): Promise<LoanBookTape> {
  const asOf = args.asOf ?? new Date();
  let facilityRef: string | null = null;
  let accounts;
  if (args.facilityId) {
    const facility = await getFacilityById(db, args.facilityId);
    if (!facility) throw new FacilityNotFoundError(args.facilityId);
    facilityRef = facility.facilityRef;
    accounts = await db
      .select()
      .from(creditAccountsExt)
      .where(eq(creditAccountsExt.facilityId, args.facilityId));
  } else {
    accounts = await db.select().from(creditAccountsExt);
  }

  const accountIds = accounts.map((a) => a.id);
  const dueDatesByAccount = new Map<string, Date[]>();
  if (accountIds.length > 0) {
    const draws = await db
      .select({ creditAccountId: creditLedger.creditAccountId, dueDate: creditLedger.dueDate })
      .from(creditLedger)
      .where(
        and(
          inArray(creditLedger.creditAccountId, accountIds),
          eq(creditLedger.kind, "invoice_draw"),
          eq(creditLedger.status, "posted"),
        ),
      );
    for (const d of draws) {
      if (!d.dueDate) continue;
      const list = dueDatesByAccount.get(d.creditAccountId) ?? [];
      list.push(new Date(d.dueDate));
      dueDatesByAccount.set(d.creditAccountId, list);
    }
  }

  const mandateIds = Array.from(new Set(accounts.map((a) => a.mandateId).filter((m): m is string => m != null)));
  const mandateStatusById = new Map<string, string>();
  if (mandateIds.length > 0) {
    const mandates = await db
      .select({ id: paymentMandates.id, status: paymentMandates.status })
      .from(paymentMandates)
      .where(inArray(paymentMandates.id, mandateIds));
    for (const m of mandates) mandateStatusById.set(m.id, m.status);
  }

  const facilityIds = Array.from(new Set(accounts.map((a) => a.facilityId).filter((f): f is string => f != null)));
  const facilityRefById = new Map<string, string>();
  if (facilityIds.length > 0) {
    const facilities = await db
      .select({ id: creditFacilities.id, facilityRef: creditFacilities.facilityRef })
      .from(creditFacilities)
      .where(inArray(creditFacilities.id, facilityIds));
    for (const f of facilities) facilityRefById.set(f.id, f.facilityRef);
  }

  const rows = buildTapeRows({ accounts, dueDatesByAccount, mandateStatusById, facilityRefById, asOf });
  return {
    asOf: asOf.toISOString(),
    facilityRef,
    rows,
    summary: summarizeTape(rows),
    csv: tapeToCsv(rows),
  };
}

/**
 * Plaintext monthly summary a lender receives for a facility (the cron hook
 * only needs the text — no email sending lives here).
 */
export async function tapeEmailPreview(db: TxHandle, facilityId: string): Promise<string> {
  const facility = await getFacilityById(db, facilityId);
  if (!facility) throw new FacilityNotFoundError(facilityId);
  const tape = await generateLoanBookTape(db, { facilityId });
  const fmtNaira = (cents: number) => `${facility.currency} ${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const bucketCount = (b: DpdBucket) => tape.rows.filter((r) => r.bucket === b).length;
  return [
    `Loan book tape — ${facility.lenderName} (${facility.facilityRef})`,
    `As of: ${tape.asOf.slice(0, 10)}`,
    ``,
    `Accounts: ${tape.summary.accountCount}`,
    `Total outstanding: ${fmtNaira(tape.summary.totalOutstandingCents)}`,
    `Commitment: ${fmtNaira(facility.commitmentCents)}`,
    `Weighted score: ${tape.summary.weightedScore ?? "n/a"}`,
    `NPL ratio (90+): ${(tape.summary.nplRatio * 100).toFixed(2)}%`,
    ``,
    `Aging: current=${bucketCount("current")} 1-30=${bucketCount("1-30")} 31-60=${bucketCount("31-60")} 61-90=${bucketCount("61-90")} 90+=${bucketCount("90+")}`,
  ].join("\n");
}
