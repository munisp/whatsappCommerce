/**
 * W18 — manufacturer credit programs (part 2).
 *
 * A `manufacturer_credit_programs` row is a manufacturer/brand tenant's
 * credit program for its merchant buyers. Buyers draw through ordinary
 * trade-credit accounts whose supplier_tenant_id is the manufacturer tenant
 * and whose program_id links them into the program book (migration 0059).
 *
 * Program-level risk controls, all integer cents/bps math:
 *   - maxExposureCents:     per-buyer outstanding cap;
 *   - programCapCents:      total program book cap;
 *   - concentrationCapBps:  max share of the book one buyer may hold.
 *
 * scoringWeights (jsonb) carries per-program scoring-weight overrides.
 * `effectiveScoringConfig(program)` resolves them against the platform
 * defaults — this is the CONTRACT for the scoring core: when
 * tradeCredit/scoring.ts accepts a config parameter (owned by another
 * stream), callers pass effectiveScoringConfig(program) straight through.
 * Until then, `suggestLimitForProgramTx` calls the existing platform scorer
 * unchanged and post-adjusts the suggested limit by the program caps:
 *   min(suggested, maxExposureCents, remaining program capacity).
 * The cap enforcement is therefore correct TODAY regardless of when the
 * weight-override integration lands.
 *
 * Local pgTable objects mirror the 0059 physical schema (same convention as
 * services/creditFacilities/tables.ts — drizzle resolves columns by
 * (table, name), so these descriptors keep working if/when schema.ts gains
 * the 0059 definitions).
 */
import { and, eq, inArray } from "drizzle-orm";
import { bigint, integer, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { getDb } from "../db";
import { creditLedger, paymentMandates } from "../../drizzle/schema";
import { suggestLimitTx, type CreditScoreResult } from "./tradeCredit/scoring";
import {
  buildTapeRows,
  summarizeTape,
  tapeToCsv,
  type TapeRow,
  type TapeSummary,
} from "./creditFacilities/tape";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Any handle exposing the drizzle query/mutation surface (db or tx).
 *  Same shape as tradeCredit's TxHandle so the scorer can be called directly. */
export type TxHandle = Pick<DbHandle, "select" | "insert" | "update" | "execute" | "transaction">;

// ─── Tables (mirror migration 0059) ─────────────────────────────────────────

export const manufacturerCreditPrograms = pgTable("manufacturer_credit_programs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: varchar("tenant_id", { length: 36 }).notNull(), // manufacturer tenant
  name: varchar("name", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("draft"), // 'draft' | 'active' | 'suspended'
  maxExposureCents: bigint("max_exposure_cents", { mode: "number" }).notNull(),
  programCapCents: bigint("program_cap_cents", { mode: "number" }).notNull(),
  concentrationCapBps: integer("concentration_cap_bps").notNull().default(10000),
  allowedTenorDays: jsonb("allowed_tenor_days").$type<number[]>().notNull().default([]),
  feeBps: integer("fee_bps").notNull().default(0),
  scoringWeights: jsonb("scoring_weights").$type<Partial<ScoringWeights> | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ManufacturerCreditProgram = typeof manufacturerCreditPrograms.$inferSelect;
export type NewManufacturerCreditProgram = typeof manufacturerCreditPrograms.$inferInsert;

/**
 * credit_accounts as extended by migration 0059 (program_id). Column subset
 * covering what this service reads/writes; hits the same physical table as
 * drizzle/schema.creditAccounts.
 */
export const creditAccountsProgram = pgTable("credit_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierTenantId: varchar("supplier_tenant_id", { length: 36 }).notNull(),
  buyerTenantId: varchar("buyer_tenant_id", { length: 36 }).notNull(),
  limitCents: bigint("limit_cents", { mode: "number" }).notNull().default(0),
  outstandingCents: bigint("outstanding_cents", { mode: "number" }).notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  score: integer("score"),
  mandateId: varchar("mandate_id", { length: 36 }),
  bureauConsentAt: timestamp("bureau_consent_at"),
  programId: varchar("program_id", { length: 36 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type CreditAccountProgram = typeof creditAccountsProgram.$inferSelect;

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ProgramNotFoundError extends Error {
  constructor(programId: string) {
    super(`Manufacturer credit program not found: ${programId}`);
    this.name = "ProgramNotFoundError";
  }
}
export class ProgramNameExistsError extends Error {
  constructor(name: string) {
    super(`Manufacturer credit program already exists for name=${name}`);
    this.name = "ProgramNameExistsError";
  }
}
export class ProgramAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Credit account not found: ${accountId}`);
    this.name = "ProgramAccountNotFoundError";
  }
}

export const PROGRAM_STATUSES = ["draft", "active", "suspended"] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

// ─── Scoring-weight overrides (contract for the scoring core) ───────────────

/**
 * Component weights of the platform scoring formula
 * (score = 100 × (wOnTime·onTime + wVolume·volumeFactor + wTenure·tenureFactor)).
 * Defaults mirror tradeCredit/scoring.ts; programs may override any subset.
 */
export interface ScoringWeights {
  onTime: number;
  volume: number;
  tenure: number;
}
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = { onTime: 0.5, volume: 0.3, tenure: 0.2 };

export interface EffectiveScoringConfig {
  weights: ScoringWeights;
  /** Which components came from the program override vs the defaults. */
  overridden: (keyof ScoringWeights)[];
}

/**
 * Resolve a program's scoringWeights override against the platform defaults.
 *
 * CONTRACT for the scoring core: once suggestLimitTx (or its successor)
 * accepts a config parameter, it MUST accept exactly this shape and apply
 * `weights` in place of the hardcoded 0.5/0.3/0.2. Weights are RELATIVE —
 * they need not sum to 1; the scoring core normalizes by their sum when
 * computing the weighted score. Invalid entries (non-finite, negative, or
 * > 1) are ignored so a malformed override can never inflate limits.
 */
export function effectiveScoringConfig(
  program?: Pick<ManufacturerCreditProgram, "scoringWeights"> | null,
): EffectiveScoringConfig {
  const overrides = program?.scoringWeights ?? null;
  const weights: ScoringWeights = { ...DEFAULT_SCORING_WEIGHTS };
  const overridden: (keyof ScoringWeights)[] = [];
  if (overrides) {
    for (const key of ["onTime", "volume", "tenure"] as const) {
      const v = overrides[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
        weights[key] = v;
        overridden.push(key);
      }
    }
  }
  return { weights, overridden };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function getProgramById(db: TxHandle, programId: string): Promise<ManufacturerCreditProgram | null> {
  const [row] = await db
    .select()
    .from(manufacturerCreditPrograms)
    .where(eq(manufacturerCreditPrograms.id, programId))
    .limit(1);
  return row ?? null;
}

/** Tenant-scoped fetch: cross-tenant program ids resolve to null. */
export async function getProgramForTenant(
  db: TxHandle,
  programId: string,
  tenantId: string,
): Promise<ManufacturerCreditProgram | null> {
  const program = await getProgramById(db, programId);
  if (!program || program.tenantId !== tenantId) return null;
  return program;
}

export async function listPrograms(db: TxHandle, tenantId: string): Promise<ManufacturerCreditProgram[]> {
  return db.select().from(manufacturerCreditPrograms).where(eq(manufacturerCreditPrograms.tenantId, tenantId));
}

function assertNonNegativeCents(field: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${field} must be a non-negative integer cents value: ${v}`);
}

export async function createProgram(
  db: TxHandle,
  args: {
    tenantId: string;
    name: string;
    maxExposureCents: number;
    programCapCents: number;
    concentrationCapBps?: number;
    allowedTenorDays?: number[];
    feeBps?: number;
    scoringWeights?: Partial<ScoringWeights> | null;
    status?: ProgramStatus;
  },
): Promise<ManufacturerCreditProgram> {
  const existing = await db
    .select({ id: manufacturerCreditPrograms.id })
    .from(manufacturerCreditPrograms)
    .where(and(eq(manufacturerCreditPrograms.tenantId, args.tenantId), eq(manufacturerCreditPrograms.name, args.name)))
    .limit(1);
  if (existing.length > 0) throw new ProgramNameExistsError(args.name);
  assertNonNegativeCents("maxExposureCents", args.maxExposureCents);
  assertNonNegativeCents("programCapCents", args.programCapCents);
  const concentrationCapBps = args.concentrationCapBps ?? 10000;
  if (!Number.isInteger(concentrationCapBps) || concentrationCapBps < 0 || concentrationCapBps > 10000) {
    throw new Error(`concentrationCapBps out of range: ${concentrationCapBps}`);
  }
  const feeBps = args.feeBps ?? 0;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error(`feeBps out of range: ${feeBps}`);
  }
  const [row] = await db
    .insert(manufacturerCreditPrograms)
    .values({
      tenantId: args.tenantId,
      name: args.name,
      status: args.status ?? "draft",
      maxExposureCents: args.maxExposureCents,
      programCapCents: args.programCapCents,
      concentrationCapBps,
      allowedTenorDays: args.allowedTenorDays ?? [],
      feeBps,
      scoringWeights: args.scoringWeights ?? null,
    })
    .returning();
  return row;
}

export async function updateProgram(
  db: TxHandle,
  args: {
    programId: string;
    tenantId: string;
    name?: string;
    maxExposureCents?: number;
    programCapCents?: number;
    concentrationCapBps?: number;
    allowedTenorDays?: number[];
    feeBps?: number;
    scoringWeights?: Partial<ScoringWeights> | null;
  },
): Promise<ManufacturerCreditProgram> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  if (args.maxExposureCents != null) assertNonNegativeCents("maxExposureCents", args.maxExposureCents);
  if (args.programCapCents != null) assertNonNegativeCents("programCapCents", args.programCapCents);
  if (args.name != null && args.name !== program.name) {
    const dupe = await db
      .select({ id: manufacturerCreditPrograms.id })
      .from(manufacturerCreditPrograms)
      .where(and(eq(manufacturerCreditPrograms.tenantId, args.tenantId), eq(manufacturerCreditPrograms.name, args.name)))
      .limit(1);
    if (dupe.length > 0) throw new ProgramNameExistsError(args.name);
  }
  // Claim-first update scoped to (id, tenantId) — cross-tenant ids match 0 rows.
  const rows = await db
    .update(manufacturerCreditPrograms)
    .set({
      ...(args.name != null ? { name: args.name } : {}),
      ...(args.maxExposureCents != null ? { maxExposureCents: args.maxExposureCents } : {}),
      ...(args.programCapCents != null ? { programCapCents: args.programCapCents } : {}),
      ...(args.concentrationCapBps != null ? { concentrationCapBps: args.concentrationCapBps } : {}),
      ...(args.allowedTenorDays != null ? { allowedTenorDays: args.allowedTenorDays } : {}),
      ...(args.feeBps != null ? { feeBps: args.feeBps } : {}),
      ...(args.scoringWeights !== undefined ? { scoringWeights: args.scoringWeights } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(manufacturerCreditPrograms.id, args.programId), eq(manufacturerCreditPrograms.tenantId, args.tenantId)))
    .returning();
  if (rows.length === 0) throw new ProgramNotFoundError(args.programId);
  return rows[0];
}

export async function setProgramStatus(
  db: TxHandle,
  args: { programId: string; tenantId: string; status: ProgramStatus },
): Promise<ManufacturerCreditProgram> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const rows = await db
    .update(manufacturerCreditPrograms)
    .set({ status: args.status, updatedAt: new Date() })
    .where(and(eq(manufacturerCreditPrograms.id, args.programId), eq(manufacturerCreditPrograms.tenantId, args.tenantId)))
    .returning();
  if (rows.length === 0) throw new ProgramNotFoundError(args.programId);
  return rows[0];
}

// ─── Account assignment ─────────────────────────────────────────────────────

/**
 * Link a trade-credit account into a program book. The account must belong
 * to the manufacturer tenant (supplier_tenant_id = program.tenantId) — a
 * program can never claim another supplier's account.
 */
export async function assignAccountToProgram(
  db: TxHandle,
  args: { programId: string; tenantId: string; accountId: string },
): Promise<{ accountId: string; programId: string }> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const [account] = await db
    .select()
    .from(creditAccountsProgram)
    .where(eq(creditAccountsProgram.id, args.accountId))
    .limit(1);
  if (!account || account.supplierTenantId !== args.tenantId) {
    throw new ProgramAccountNotFoundError(args.accountId);
  }
  await db
    .update(creditAccountsProgram)
    .set({ programId: args.programId, updatedAt: new Date() })
    .where(eq(creditAccountsProgram.id, args.accountId));
  return { accountId: args.accountId, programId: args.programId };
}

export async function unassignAccountFromProgram(
  db: TxHandle,
  args: { programId: string; tenantId: string; accountId: string },
): Promise<{ accountId: string; programId: null }> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const [account] = await db
    .select()
    .from(creditAccountsProgram)
    .where(eq(creditAccountsProgram.id, args.accountId))
    .limit(1);
  if (!account || account.programId !== args.programId) {
    throw new ProgramAccountNotFoundError(args.accountId);
  }
  await db
    .update(creditAccountsProgram)
    .set({ programId: null, updatedAt: new Date() })
    .where(eq(creditAccountsProgram.id, args.accountId));
  return { accountId: args.accountId, programId: null };
}

/** Accounts linked into the program book. */
export async function listProgramAccounts(db: TxHandle, programId: string): Promise<CreditAccountProgram[]> {
  return db.select().from(creditAccountsProgram).where(eq(creditAccountsProgram.programId, programId));
}

// ─── Draw gating (pure core + db wrapper) ───────────────────────────────────

export interface DrawCheckInput {
  programStatus: string;
  maxExposureCents: number;
  programCapCents: number;
  concentrationCapBps: number;
  /** Current outstanding of the buyer requesting the draw (integer cents). */
  buyerOutstandingCents: number;
  /** Current outstanding of the whole program book (integer cents). */
  bookOutstandingCents: number;
  amountCents: number;
}

export interface DrawCheckResult {
  allowed: boolean;
  reasons: string[];
}

/**
 * Pure draw gate. Post-draw state must satisfy ALL of:
 *   1. program is active;
 *   2. per-buyer exposure: buyerOutstanding + amount ≤ maxExposureCents;
 *   3. program cap:        bookOutstanding + amount ≤ programCapCents;
 *   4. concentration:      (buyerOutstanding + amount)·10000
 *                          ≤ concentrationCapBps · (bookOutstanding + amount)
 *      (cross-multiplied so the bps comparison stays exact integer math).
 * Every violated rule contributes a human-readable reason.
 */
export function evaluateDraw(input: DrawCheckInput): DrawCheckResult {
  const reasons: string[] = [];
  const amountCents = Math.round(input.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { allowed: false, reasons: [`draw amount must be a positive integer cents value: ${input.amountCents}`] };
  }
  const buyerAfter = input.buyerOutstandingCents + amountCents;
  const bookAfter = input.bookOutstandingCents + amountCents;

  if (input.programStatus !== "active") {
    reasons.push(`program is ${input.programStatus} — draws only allowed while active`);
  }
  if (buyerAfter > input.maxExposureCents) {
    reasons.push(
      `per-buyer exposure exceeded: ${buyerAfter} > maxExposureCents ${input.maxExposureCents}`,
    );
  }
  if (bookAfter > input.programCapCents) {
    reasons.push(`program cap exceeded: ${bookAfter} > programCapCents ${input.programCapCents}`);
  }
  if (buyerAfter * 10_000 > input.concentrationCapBps * bookAfter) {
    const shareBps = Math.round((buyerAfter / bookAfter) * 10_000);
    reasons.push(
      `concentration cap exceeded: buyer would hold ${shareBps}bps of the book > cap ${input.concentrationCapBps}bps`,
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * checkDrawAllowed — gate a buyer draw of `amountCents` under the program.
 * Tenant-scoped: the caller's tenantId must own the program.
 */
export async function checkDrawAllowed(
  db: TxHandle,
  args: { programId: string; tenantId: string; buyerTenantId: string; amountCents: number },
): Promise<DrawCheckResult> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const accounts = await listProgramAccounts(db, program.id);
  let bookOutstandingCents = 0;
  let buyerOutstandingCents = 0;
  for (const a of accounts) {
    bookOutstandingCents += a.outstandingCents;
    if (a.buyerTenantId === args.buyerTenantId) buyerOutstandingCents += a.outstandingCents;
  }
  return evaluateDraw({
    programStatus: program.status,
    maxExposureCents: program.maxExposureCents,
    programCapCents: program.programCapCents,
    concentrationCapBps: program.concentrationCapBps,
    buyerOutstandingCents,
    bookOutstandingCents,
    amountCents: args.amountCents,
  });
}

// ─── Program book ───────────────────────────────────────────────────────────

export interface ProgramBookAccount {
  accountId: string;
  buyerTenantId: string;
  limitCents: number;
  outstandingCents: number;
  status: string;
  score: number | null;
}

export interface ProgramBook {
  programId: string;
  status: string;
  accountCount: number;
  totalOutstandingCents: number;
  totalLimitCents: number;
  programCapCents: number;
  maxExposureCents: number;
  concentrationCapBps: number;
  /** outstanding / programCap in bps (0 when cap is 0). */
  utilizationBps: number;
  /** Remaining program capacity, floored at 0. */
  remainingCapacityCents: number;
  /** Per-buyer concentration, largest exposure first. */
  concentration: Array<{ buyerTenantId: string; outstandingCents: number; shareBps: number }>;
  accounts: ProgramBookAccount[];
}

/** Pure book aggregation — exported for unit tests. */
export function buildProgramBook(
  program: ManufacturerCreditProgram,
  accounts: Array<Pick<CreditAccountProgram, "id" | "buyerTenantId" | "limitCents" | "outstandingCents" | "status" | "score">>,
): ProgramBook {
  let totalOutstandingCents = 0;
  let totalLimitCents = 0;
  const byBuyer = new Map<string, number>();
  for (const a of accounts) {
    totalOutstandingCents += a.outstandingCents;
    totalLimitCents += a.limitCents;
    byBuyer.set(a.buyerTenantId, (byBuyer.get(a.buyerTenantId) ?? 0) + a.outstandingCents);
  }
  const concentration = Array.from(byBuyer.entries())
    .map(([buyerTenantId, outstandingCents]) => ({
      buyerTenantId,
      outstandingCents,
      shareBps: totalOutstandingCents > 0 ? Math.round((outstandingCents / totalOutstandingCents) * 10_000) : 0,
    }))
    .sort((x, y) => y.outstandingCents - x.outstandingCents || (x.buyerTenantId < y.buyerTenantId ? -1 : 1));
  return {
    programId: program.id,
    status: program.status,
    accountCount: accounts.length,
    totalOutstandingCents,
    totalLimitCents,
    programCapCents: program.programCapCents,
    maxExposureCents: program.maxExposureCents,
    concentrationCapBps: program.concentrationCapBps,
    utilizationBps:
      program.programCapCents > 0 ? Math.round((totalOutstandingCents / program.programCapCents) * 10_000) : 0,
    remainingCapacityCents: Math.max(0, program.programCapCents - totalOutstandingCents),
    concentration,
    accounts: accounts.map((a) => ({
      accountId: a.id,
      buyerTenantId: a.buyerTenantId,
      limitCents: a.limitCents,
      outstandingCents: a.outstandingCents,
      status: a.status,
      score: a.score ?? null,
    })),
  };
}

export async function getProgramBook(
  db: TxHandle,
  args: { programId: string; tenantId: string },
): Promise<ProgramBook> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const accounts = await listProgramAccounts(db, program.id);
  return buildProgramBook(program, accounts);
}

// ─── Program-aware limit suggestion ─────────────────────────────────────────

export interface ProgramLimitSuggestion extends CreditScoreResult {
  /** The platform scorer's raw suggestion before program caps. */
  baseSuggestedLimitCents: number;
  programId: string;
}

/**
 * Thin wrapper over the existing scorer: suggestLimitTx is called with the
 * manufacturer tenant as supplierTenantId (activating the read side of the
 * reserved per-supplier parameter), then the suggestion is post-adjusted by
 * the program caps:
 *   min(suggested, maxExposureCents, remaining program capacity)
 * so the result is safe to apply TODAY. When the scoring core accepts an
 * effectiveScoringConfig parameter, thread `effectiveScoringConfig(program)`
 * through here — the cap adjustment stays either way.
 *
 * `scoreFn` is injectable for unit tests; production callers use the default.
 */
export async function suggestLimitForProgramTx(
  db: TxHandle,
  args: { programId: string; tenantId: string; buyerTenantId: string },
  scoreFn: (
    db: Parameters<typeof suggestLimitTx>[0],
    buyerTenantId: string,
    supplierTenantId: string,
  ) => Promise<CreditScoreResult> = (scoreDb, buyerTenantId, supplierTenantId) =>
    suggestLimitTx(scoreDb, buyerTenantId, supplierTenantId),
): Promise<ProgramLimitSuggestion> {
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const base = await scoreFn(db, args.buyerTenantId, program.tenantId);
  const accounts = await listProgramAccounts(db, program.id);
  const bookOutstandingCents = accounts.reduce((s, a) => s + a.outstandingCents, 0);
  const remainingCapacityCents = Math.max(0, program.programCapCents - bookOutstandingCents);
  const suggestedLimitCents = Math.min(base.suggestedLimitCents, program.maxExposureCents, remainingCapacityCents);
  const reasons = [...base.reasons];
  if (suggestedLimitCents < base.suggestedLimitCents) {
    reasons.push(
      `capped by program: min(platform ${base.suggestedLimitCents}, maxExposure ${program.maxExposureCents}, remaining capacity ${remainingCapacityCents})`,
    );
  }
  return {
    score: base.score,
    suggestedLimitCents,
    baseSuggestedLimitCents: base.suggestedLimitCents,
    programId: program.id,
    reasons,
    terms: base.terms,
    antiGamingFlags: base.antiGamingFlags,
  };
}

// ─── Program-scoped loan tape ───────────────────────────────────────────────

export interface ProgramTapeSummary extends TapeSummary {
  utilizationBps: number;
  remainingCapacityCents: number;
  /** Top-5 buyers by outstanding (from the program book concentration). */
  topConcentration: Array<{ buyerTenantId: string; outstandingCents: number; shareBps: number }>;
}

export interface ProgramTape {
  asOf: string;
  programId: string;
  programName: string;
  rows: TapeRow[];
  summary: ProgramTapeSummary;
  csv: string;
}

/**
 * Program-scoped loan-book tape: one row per assigned account (limit /
 * outstanding / score / DPD bucket / bureau consent / mandate status),
 * reusing the W14 tape pure functions, plus a program summary (utilization
 * vs cap, top-5 concentration) and a CSV rendering.
 */
export async function generateProgramTape(
  db: TxHandle,
  args: { programId: string; tenantId: string; asOf?: Date },
): Promise<ProgramTape> {
  const asOf = args.asOf ?? new Date();
  const program = await getProgramForTenant(db, args.programId, args.tenantId);
  if (!program) throw new ProgramNotFoundError(args.programId);
  const accounts = await listProgramAccounts(db, program.id);

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

  const rows = buildTapeRows({
    accounts: accounts.map((a) => ({ ...a, bureauConsentRef: null, facilityId: null })),
    dueDatesByAccount,
    mandateStatusById,
    facilityRefById: new Map(),
    asOf,
  });
  const book = buildProgramBook(program, accounts);
  return {
    asOf: asOf.toISOString(),
    programId: program.id,
    programName: program.name,
    rows,
    summary: {
      ...summarizeTape(rows),
      utilizationBps: book.utilizationBps,
      remainingCapacityCents: book.remainingCapacityCents,
      topConcentration: book.concentration.slice(0, 5),
    },
    csv: tapeToCsv(rows),
  };
}
