/**
 * W14 F4 — credit facility (lender warehouse line) administration.
 *
 * A credit_facility is a lender's committed line against which supplier
 * credit accounts (the trade-credit book) are assigned as collateral.
 * Utilization = SUM(outstanding of assigned accounts) / commitment, and
 * availableToAdvance = commitment × advanceRateBps/10000 − outstanding of
 * assigned accounts (never negative).
 *
 * All functions take the caller's db handle (repo convention, see
 * services/tradeCredit) so the router can compose them in one transaction.
 * Money is integer cents throughout — no floats anywhere on money paths.
 */
import { eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { creditAccountsExt, creditFacilities, type CreditFacility } from "./tables";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle query/mutation surface (db or tx). */
export type TxHandle = Pick<DbHandle, "select" | "insert" | "update">;

export class FacilityRefExistsError extends Error {
  constructor(facilityRef: string) {
    super(`Credit facility already exists for ref=${facilityRef}`);
    this.name = "FacilityRefExistsError";
  }
}
export class FacilityNotFoundError extends Error {
  constructor(facilityId: string) {
    super(`Credit facility not found: ${facilityId}`);
    this.name = "FacilityNotFoundError";
  }
}
export class CreditAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Credit account not found: ${accountId}`);
    this.name = "CreditAccountNotFoundError";
  }
}

export interface FacilityUtilization {
  facilityId: string;
  accountCount: number;
  /** SUM(outstanding_cents) over accounts assigned to the facility. */
  outstandingCents: number;
  commitmentCents: number;
  /** outstanding / commitment, in basis points (0 when commitment is 0). */
  utilizationBps: number;
  /** commitment × advanceRateBps/10000 − outstanding, floored at 0. */
  availableToAdvanceCents: number;
}

export type FacilityWithUtilization = CreditFacility & { utilization: FacilityUtilization };

/** Fetch a facility by primary key, or null. */
export async function getFacilityById(db: TxHandle, facilityId: string): Promise<CreditFacility | null> {
  const [row] = await db.select().from(creditFacilities).where(eq(creditFacilities.id, facilityId)).limit(1);
  return row ?? null;
}

/** Fetch a facility by its unique lender-facing reference, or null. */
export async function getFacilityByRef(db: TxHandle, facilityRef: string): Promise<CreditFacility | null> {
  const [row] = await db
    .select()
    .from(creditFacilities)
    .where(eq(creditFacilities.facilityRef, facilityRef))
    .limit(1);
  return row ?? null;
}

/**
 * Create a lender facility. facility_ref is UNIQUE — duplicates surface as
 * FacilityRefExistsError (checked first so the error is deterministic).
 */
export async function createFacility(
  db: TxHandle,
  args: {
    lenderName: string;
    facilityRef: string;
    commitmentCents: number;
    currency?: string;
    advanceRateBps?: number;
    covenants?: Record<string, unknown> | null;
    status?: string;
  },
): Promise<CreditFacility> {
  const existing = await getFacilityByRef(db, args.facilityRef);
  if (existing) throw new FacilityRefExistsError(args.facilityRef);
  const advanceRateBps = args.advanceRateBps ?? 8000;
  if (advanceRateBps < 0 || advanceRateBps > 10000) {
    throw new Error(`advanceRateBps out of range: ${advanceRateBps}`);
  }
  const [row] = await db
    .insert(creditFacilities)
    .values({
      lenderName: args.lenderName,
      facilityRef: args.facilityRef,
      commitmentCents: Math.max(0, Math.round(args.commitmentCents)),
      currency: args.currency ?? "NGN",
      advanceRateBps,
      covenants: args.covenants ?? null,
      status: args.status ?? "active",
    })
    .returning();
  return row;
}

/**
 * Assign a credit account to a facility (sets credit_accounts.facility_id).
 * Both the facility and the account must exist; the update is claim-first
 * scoped to the account id so the returned row proves the assignment.
 */
export async function assignAccountToFacility(
  db: TxHandle,
  args: { accountId: string; facilityId: string },
): Promise<{ accountId: string; facilityId: string }> {
  const facility = await getFacilityById(db, args.facilityId);
  if (!facility) throw new FacilityNotFoundError(args.facilityId);
  const rows = await db
    .update(creditAccountsExt)
    .set({ facilityId: args.facilityId, updatedAt: new Date() })
    .where(eq(creditAccountsExt.id, args.accountId))
    .returning();
  if (rows.length === 0) throw new CreditAccountNotFoundError(args.accountId);
  return { accountId: args.accountId, facilityId: args.facilityId };
}

/**
 * Compute utilization for one facility: the SUM of outstanding over assigned
 * accounts vs commitment, plus the advance-rate headroom.
 */
export async function getFacilityUtilization(db: TxHandle, facilityId: string): Promise<FacilityUtilization> {
  const facility = await getFacilityById(db, facilityId);
  if (!facility) throw new FacilityNotFoundError(facilityId);
  const accounts = await db
    .select({ outstandingCents: creditAccountsExt.outstandingCents })
    .from(creditAccountsExt)
    .where(eq(creditAccountsExt.facilityId, facilityId));
  return computeUtilization(facility, accounts.map((a) => a.outstandingCents));
}

/** Pure utilization math — exported for unit tests. */
export function computeUtilization(
  facility: Pick<CreditFacility, "id" | "commitmentCents" | "advanceRateBps">,
  outstandingList: number[],
): FacilityUtilization {
  const outstandingCents = outstandingList.reduce((s, v) => s + v, 0);
  const commitmentCents = facility.commitmentCents;
  const utilizationBps = commitmentCents > 0 ? Math.round((outstandingCents / commitmentCents) * 10_000) : 0;
  const advanceCapacityCents = Math.floor((commitmentCents * facility.advanceRateBps) / 10_000);
  const availableToAdvanceCents = Math.max(0, advanceCapacityCents - outstandingCents);
  return {
    facilityId: facility.id,
    accountCount: outstandingList.length,
    outstandingCents,
    commitmentCents,
    utilizationBps,
    availableToAdvanceCents,
  };
}

/** List all facilities, each with its computed utilization. */
export async function listFacilities(db: TxHandle): Promise<FacilityWithUtilization[]> {
  const facilities = await db.select().from(creditFacilities);
  if (facilities.length === 0) return [];
  const accounts = await db
    .select({
      facilityId: creditAccountsExt.facilityId,
      outstandingCents: creditAccountsExt.outstandingCents,
    })
    .from(creditAccountsExt);
  const byFacility = new Map<string, number[]>();
  for (const a of accounts) {
    if (!a.facilityId) continue;
    const list = byFacility.get(a.facilityId) ?? [];
    list.push(a.outstandingCents);
    byFacility.set(a.facilityId, list);
  }
  return facilities.map((f) => ({ ...f, utilization: computeUtilization(f, byFacility.get(f.id) ?? []) }));
}
