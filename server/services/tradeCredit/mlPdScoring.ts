/**
 * server/services/tradeCredit/mlPdScoring.ts — W21 ML probability-of-default
 * (PD) credit model + expected-loss pricing, layered ON TOP of the rule-based
 * trade-credit scorer (scoring.ts).
 *
 * Mirrors the W20 mlLeadScoring.ts conventions:
 *   - pure TypeScript logistic regression (NO new npm dependencies),
 *   - deterministic training (mulberry32 fixed seed, fixed iteration count,
 *     L2 regularization, rows sorted by buyer id),
 *   - minimum-sample gate (PD_MODEL_PARAMS.minTrainSamples),
 *   - model registry table credit_pd_models (migration 0063) with
 *     tenant_id NULLABLE — a null-tenant row is the GLOBAL corpus model,
 *     used as a fallback when a tenant's own book is below the gate,
 *   - never-throws scoring contract with fallbackUsed flag.
 *
 * Labels (positive PD class = bad outcome) are derived from the SAME credit
 * repayment signals scoring.ts reads: a buyer with any late draw
 * (`[dun:fee]` / `[dun:r+7]` dunning markers) or an active default (frozen
 * account / draw overdue past the freeze horizon) is labeled 1; a buyer with
 * fully settled, marker-free draws back at zero outstanding is labeled 0.
 * Buyers with no resolved outcome yet are excluded from the training set.
 *
 * Features are a numeric vector aligned with the rule factors (see
 * PD_FEATURE_NAMES), normalized to [0,1].
 *
 * Expected-loss pricing: expectedLossTerms(pd, tenorDays) converts a PD into
 * a continuous fee in basis points:
 *     feeBps = clamp(round(pd * LGD * tenorFactor * 10_000 + marginBps), min, max)
 * with tenorFactor = tenorDays / TENOR_BASELINE_DAYS. The result is clamped
 * to the TERMS_BANDS envelope — callers additionally cap it at the fee band
 * the rule score implies (bands remain policy caps; ML can only improve on
 * them, never worsen them).
 *
 * Fallback contract: scorePd NEVER throws. No trained model (tenant or
 * global), below gate, missing buyer, or any DB error →
 * { fallbackUsed: true } and the PD proxy is derived from the rule score
 * (pd = 1 − score/100).
 *
 * Cron wiring: /api/scheduled/pd-model-tick → runPdModelTick (mirrors the
 * lead-model-tick pattern in server/_core/index.ts).
 */
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  creditAccounts,
  creditLedger,
  creditPdModels,
  orders,
  paymentTransactions,
} from "../../../drizzle/schema";
import type { TxHandle } from "./accounts";
import { adjustVolumeTx, FLAG_UNAVAILABLE } from "./antiGaming";

// ─── Tunables (imported by tests — never hardcode elsewhere) ────────────────
export const PD_MODEL_PARAMS = {
  /** Deterministic PRNG seed for weight initialization. */
  seed: 2024,
  /** Fixed gradient-descent iterations. */
  iterations: 400,
  learningRate: 0.5,
  /** L2 penalty (not applied to the bias term). */
  l2: 0.001,
  /** Below this many labeled accounts the model is NOT trained. */
  minTrainSamples: 40,
  /** sampleCount at which the sample-size confidence factor saturates. */
  confidenceSampleSaturation: 200,
} as const;

/** Expected-loss pricing constants (one block for testability). */
export const EL_PRICING = {
  /** Loss given default (share of exposure lost on default). */
  lgd: 0.5,
  /** Flat margin added on top of the expected-loss component, in bps. */
  marginBps: 100,
  /** Tenor at which tenorFactor = 1 (fee scales linearly with tenor). */
  tenorBaselineDays: 30,
  /** Envelope clamps — the widest TERMS_BANDS fee range. */
  minFeeBps: 0,
  maxFeeBps: 350,
} as const;

/** Feature names, aligned with the vector returned by pdFeaturesForBuyer. */
export const PD_FEATURE_NAMES = [
  "onTimeRatio", // completed payments within 24h / completed (0.5 neutral prior)
  "lateCount", // min(late draws, 3) / 3
  "defaultCount", // min(active defaults, 2) / 2
  "utilization", // outstanding/limit clamped [0,1]
  "tenureDays", // min(days since first order, 365) / 365
  "volume90dLog", // log1p(90d GMV cents) / log1p(cap)
  "cureEvents", // min(cured-at-zero accounts, 2) / 2
  "antiGamingFlags", // min(flag count, 5) / 5
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const VOLUME_CAP_CENTS = 5_000_000_000; // ₦50M → log-scale cap
const ON_TIME_WINDOW_MS = DAY_MS; // 24h, same as scoring.ts
const LATE_MARKERS = ["[dun:fee]", "[dun:r+7]"] as const;
const FREEZE_OVERDUE_DAYS = 7;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// ─── Pure math ──────────────────────────────────────────────────────────────

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Deterministic PRNG (mulberry32) so tests reproduce weights exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PdTrainingRow {
  x: number[]; // length PD_FEATURE_NAMES.length, values in [0,1]
  y: 0 | 1; // 1 = bad outcome (late/default), 0 = repaid on time
}

export interface TrainedPdModel {
  /** weights[0] is the bias; weights[i+1] multiplies feature i. */
  weights: number[];
  logloss: number;
  /** Rank AUC on the training set (null when single-class). */
  auc: number | null;
}

export function predictPd(weights: number[], x: number[]): number {
  let z = weights[0] ?? 0;
  for (let i = 0; i < x.length; i++) z += (weights[i + 1] ?? 0) * x[i];
  return sigmoid(z);
}

export function logitOf(weights: number[], x: number[]): number {
  let z = weights[0] ?? 0;
  for (let i = 0; i < x.length; i++) z += (weights[i + 1] ?? 0) * x[i];
  return z;
}

export function meanLogLoss(weights: number[], rows: PdTrainingRow[], l2 = 0): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, predictPd(weights, r.x)));
    sum += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }
  let penalty = 0;
  for (let i = 1; i < weights.length; i++) penalty += weights[i] * weights[i];
  return sum / rows.length + (l2 / 2) * penalty;
}

/** Rank-based AUC (probability a random positive outranks a random negative). */
export function rankAuc(weights: number[], rows: PdTrainingRow[]): number | null {
  const pos = rows.filter((r) => r.y === 1);
  const neg = rows.filter((r) => r.y === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  const scored = rows
    .map((r) => ({ p: predictPd(weights, r.x), y: r.y }))
    .sort((a, b) => a.p - b.p);
  // Average ranks for ties.
  let rankSum = 0;
  for (let i = 0; i < scored.length; ) {
    let j = i;
    while (j + 1 < scored.length && scored[j + 1].p === scored[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (scored[k].y === 1) rankSum += avgRank;
    i = j + 1;
  }
  const auc = (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
  return Math.round(auc * 1e6) / 1e6;
}

/**
 * Full-batch gradient descent on log-loss with L2 regularization.
 * Deterministic: fixed seed → fixed initialization, fixed iteration count,
 * input order preserved (callers sort rows by buyer id).
 */
export function trainLogisticRegression(
  rows: PdTrainingRow[],
  opts: { seed?: number; iterations?: number; learningRate?: number; l2?: number } = {},
): TrainedPdModel {
  const seed = opts.seed ?? PD_MODEL_PARAMS.seed;
  const iterations = opts.iterations ?? PD_MODEL_PARAMS.iterations;
  const lr = opts.learningRate ?? PD_MODEL_PARAMS.learningRate;
  const l2 = opts.l2 ?? PD_MODEL_PARAMS.l2;
  const nFeat = rows[0]?.x.length ?? PD_FEATURE_NAMES.length;

  const rng = mulberry32(seed);
  const weights = Array.from({ length: nFeat + 1 }, () => (rng() - 0.5) * 0.01);

  const n = rows.length;
  if (n === 0) return { weights, logloss: 0, auc: null };

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array<number>(weights.length).fill(0);
    for (const r of rows) {
      const err = predictPd(weights, r.x) - r.y;
      grad[0] += err;
      for (let i = 0; i < r.x.length; i++) grad[i + 1] += err * r.x[i];
    }
    weights[0] -= lr * (grad[0] / n);
    for (let i = 1; i < weights.length; i++) {
      weights[i] -= lr * (grad[i] / n + l2 * weights[i]);
    }
  }
  return { weights, logloss: meanLogLoss(weights, rows, l2), auc: rankAuc(weights, rows) };
}

// ─── Expected-loss pricing ──────────────────────────────────────────────────

export interface ExpectedLossTerms {
  feeBps: number;
  /** Expected-loss component before the margin, in bps (unclamped, rounded). */
  expectedLossBps: number;
  lgd: number;
  tenorFactor: number;
}

/**
 * Continuous expected-loss fee:
 *   feeBps = clamp(round(pd * LGD * (tenorDays / TENOR_BASELINE) * 10_000
 *                     + marginBps), MIN_FEE_BPS, MAX_FEE_BPS)
 * Pure function — deterministic, no I/O. The min/max envelope matches the
 * widest TERMS_BANDS fee range (0..350bps); callers cap the result at the
 * rule-score band fee so ML can never worsen the policy band.
 */
export function expectedLossTerms(pd: number, tenorDays: number): ExpectedLossTerms {
  const p = clamp01(Number.isFinite(pd) ? pd : 1);
  const tenorFactor = Math.max(0, tenorDays) / EL_PRICING.tenorBaselineDays;
  const expectedLossBps = Math.round(p * EL_PRICING.lgd * tenorFactor * 10_000);
  const raw = expectedLossBps + EL_PRICING.marginBps;
  const feeBps = Math.max(EL_PRICING.minFeeBps, Math.min(EL_PRICING.maxFeeBps, raw));
  return { feeBps, expectedLossBps, lgd: EL_PRICING.lgd, tenorFactor };
}

// ─── Signal extraction ──────────────────────────────────────────────────────

export interface BuyerPdSignals {
  hasHistory: boolean;
  /** Resolved outcome: 1 = late/default, 0 = clean repaid, null = unresolved. */
  label: 0 | 1 | null;
  onTimeRatio: number;
  lateCount: number;
  defaultCount: number;
  utilization: number;
  tenureDays: number;
  volume90dCents: number;
  cureEvents: number;
  antiGamingFlagCount: number;
}

/**
 * Credit-outcome signals for one buyer tenant, derived the SAME way
 * scoring.ts reads them (dunning markers, frozen accounts, overdue posted
 * draws, settled draws, cure-at-zero, utilization). Platform-wide across all
 * suppliers (documented in scoring.ts).
 */
export async function buyerPdSignalsTx(
  db: TxHandle,
  buyerTenantId: string,
  now: Date = new Date(),
): Promise<BuyerPdSignals> {
  const accounts = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.buyerTenantId, buyerTenantId));

  let lateCount = 0;
  let defaultCount = 0;
  let cureEvents = 0;
  let cleanSettled = 0;
  let limitSum = 0;
  let outstandingSum = 0;
  let hasHistory = false;
  let unresolved = false;

  for (const account of accounts as any[]) {
    const rows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.creditAccountId, account.id));
    const draws = rows.filter((r: any) => r.kind === "invoice_draw" && r.status !== "void");
    if (draws.length === 0) continue;
    hasHistory = true;

    const lateDraws = draws.filter((d: any) =>
      LATE_MARKERS.some((m) => String(d.note ?? "").includes(m)),
    );
    lateCount += lateDraws.length;

    let accountDefault = account.status === "frozen";
    const overduePosted = draws.some((d: any) => {
      if (d.status !== "posted" || !d.dueDate) return false;
      const overdueDays = Math.floor((now.getTime() - new Date(d.dueDate).getTime()) / DAY_MS);
      return overdueDays > FREEZE_OVERDUE_DAYS;
    });
    if (overduePosted) accountDefault = true;
    if (accountDefault) defaultCount += 1;

    const settledDraws = draws.filter((d: any) => d.status === "settled");
    if (settledDraws.length > 0 && lateDraws.length === 0 && Number(account.outstandingCents) === 0) {
      cleanSettled += 1;
    }
    if (lateDraws.length > 0 && Number(account.outstandingCents) === 0) cureEvents += 1;
    if (settledDraws.length < draws.length && !accountDefault && lateDraws.length === 0) {
      unresolved = true; // draws still open with no outcome yet
    }

    limitSum += Math.max(0, Number(account.limitCents) ?? 0);
    outstandingSum += Math.max(0, Number(account.outstandingCents) ?? 0);
  }

  const label: 0 | 1 | null = !hasHistory
    ? null
    : lateCount > 0 || defaultCount > 0
      ? 1
      : cleanSettled > 0 && !unresolved
        ? 0
        : null;

  // Payment timeliness (same window as scoring.ts).
  const completedPayments = await db
    .select({ createdAt: paymentTransactions.createdAt, paidAt: paymentTransactions.paidAt })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.tenantId, buyerTenantId), eq(paymentTransactions.status, "completed")))
    .orderBy(desc(paymentTransactions.createdAt));
  const onTimeCount = completedPayments.filter((p: any) => {
    if (!p.paidAt) return false;
    return new Date(p.paidAt).getTime() - new Date(p.createdAt).getTime() <= ON_TIME_WINDOW_MS;
  }).length;
  const onTimeRatio = completedPayments.length > 0 ? onTimeCount / completedPayments.length : 0.5;

  // Tenure (days since first order) + 90-day GMV.
  const [firstOrder] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .where(eq(orders.tenantId, buyerTenantId))
    .orderBy(asc(orders.createdAt))
    .limit(1);
  const tenureDays = firstOrder
    ? Math.max(0, Math.floor((now.getTime() - new Date(firstOrder.createdAt).getTime()) / DAY_MS))
    : 0;
  const since90d = new Date(now.getTime() - 90 * DAY_MS);
  const recentOrders = await db
    .select({ totalAmount: orders.totalAmount })
    .from(orders)
    .where(and(eq(orders.tenantId, buyerTenantId), gte(orders.createdAt, since90d)));
  const volume90dCents = recentOrders.reduce(
    (sum: number, o: any) => sum + Math.round(Number(o.totalAmount) * 100),
    0,
  );

  // Anti-gaming flag count (fail-open: unavailable → 1 flag, matching the
  // scoring.ts FLAG_UNAVAILABLE behavior).
  let antiGamingFlagCount = 0;
  try {
    const ag = await adjustVolumeTx(db, buyerTenantId, now);
    antiGamingFlagCount = ag.flags.length;
  } catch {
    antiGamingFlagCount = 1; // FLAG_UNAVAILABLE equivalent
  }

  return {
    hasHistory,
    label,
    onTimeRatio,
    lateCount,
    defaultCount,
    utilization: limitSum > 0 ? clamp01(outstandingSum / limitSum) : 0,
    tenureDays,
    volume90dCents,
    cureEvents,
    antiGamingFlagCount,
  };
}

/** Numeric feature vector from signals (values in [0,1], aligned with PD_FEATURE_NAMES). */
export function pdFeaturesFromSignals(sig: BuyerPdSignals): number[] {
  return [
    clamp01(sig.onTimeRatio),
    Math.min(sig.lateCount, 3) / 3,
    Math.min(sig.defaultCount, 2) / 2,
    clamp01(sig.utilization),
    clamp01(Math.min(sig.tenureDays, 365) / 365),
    clamp01(Math.log1p(Math.max(0, sig.volume90dCents)) / Math.log1p(VOLUME_CAP_CENTS)),
    Math.min(sig.cureEvents, 2) / 2,
    Math.min(sig.antiGamingFlagCount, 5) / 5,
  ];
}

export async function pdFeaturesForBuyer(
  db: TxHandle,
  buyerTenantId: string,
  now: Date = new Date(),
): Promise<number[]> {
  return pdFeaturesFromSignals(await buyerPdSignalsTx(db, buyerTenantId, now));
}

// ─── Training-set construction ──────────────────────────────────────────────

/**
 * Labeled rows for one supplier tenant's book (tenantId non-null: buyers
 * with a credit account from THIS supplier) or for the global corpus
 * (tenantId null: every buyer with credit history platform-wide). Buyers
 * with unresolved outcomes are excluded. Rows are sorted by buyer id so
 * training is deterministic.
 */
export async function buildPdTrainingRows(
  db: TxHandle,
  tenantId: string | null,
  now: Date = new Date(),
): Promise<PdTrainingRow[]> {
  const accountRows = tenantId === null
    ? await db.select({ buyerTenantId: creditAccounts.buyerTenantId }).from(creditAccounts)
    : await db
        .select({ buyerTenantId: creditAccounts.buyerTenantId })
        .from(creditAccounts)
        .where(eq(creditAccounts.supplierTenantId, tenantId));
  const buyerIds = Array.from(new Set((accountRows as any[]).map((r) => r.buyerTenantId as string))).sort();

  const rows: PdTrainingRow[] = [];
  for (const buyerId of buyerIds) {
    const sig = await buyerPdSignalsTx(db, buyerId, now);
    if (sig.label === null) continue;
    rows.push({ x: pdFeaturesFromSignals(sig), y: sig.label });
  }
  return rows;
}

// ─── Model persistence ──────────────────────────────────────────────────────

export interface StoredPdModel {
  id: string;
  /** null = global corpus model. */
  tenantId: string | null;
  weights: number[];
  featureNames: string[];
  trainedAt: Date;
  sampleCount: number;
  logloss: number | null;
  auc: number | null;
  version: number;
}

function storedFromRow(row: any): StoredPdModel {
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    weights: (row.weights as number[]) ?? [],
    featureNames: (row.featureNames as string[]) ?? [],
    trainedAt: row.trainedAt,
    sampleCount: row.sampleCount,
    logloss: row.logloss == null ? null : Number(row.logloss),
    auc: row.auc == null ? null : Number(row.auc),
    version: row.version,
  };
}

/** Latest trained model for a scope (tenantId null = global), or null. */
export async function loadLatestPdModel(
  db: TxHandle,
  tenantId: string | null,
): Promise<StoredPdModel | null> {
  const where = tenantId === null
    ? isNull(creditPdModels.tenantId)
    : eq(creditPdModels.tenantId, tenantId);
  const [row] = await db
    .select()
    .from(creditPdModels)
    .where(where)
    .orderBy(desc(creditPdModels.version))
    .limit(1);
  return row ? storedFromRow(row) : null;
}

/**
 * Resolution order for scoring: the tenant's own model first, then the
 * global (null-tenant) corpus model. `source` records which was used.
 */
export async function resolvePdModel(
  db: TxHandle,
  tenantId: string,
): Promise<{ model: StoredPdModel; source: "tenant" | "global" } | null> {
  const tenantModel = await loadLatestPdModel(db, tenantId);
  if (tenantModel) return { model: tenantModel, source: "tenant" };
  const globalModel = await loadLatestPdModel(db, null);
  if (globalModel) return { model: globalModel, source: "global" };
  return null;
}

export interface PdTrainResult {
  trained: boolean;
  reason?: "insufficient_samples";
  sampleCount: number;
  version: number | null;
  logloss: number | null;
  auc: number | null;
  trainedAt: Date | null;
}

/**
 * Train + persist a new model version for the scope (tenantId null trains
 * the global corpus model). Below the minimum-sample gate no row is written
 * and trained=false is returned.
 */
export async function trainPdModelTx(
  db: TxHandle,
  tenantId: string | null,
  now: Date = new Date(),
): Promise<PdTrainResult> {
  const rows = await buildPdTrainingRows(db, tenantId, now);
  if (rows.length < PD_MODEL_PARAMS.minTrainSamples) {
    return {
      trained: false,
      reason: "insufficient_samples",
      sampleCount: rows.length,
      version: null,
      logloss: null,
      auc: null,
      trainedAt: null,
    };
  }
  const model = trainLogisticRegression(rows);
  const scopeWhere = tenantId === null
    ? isNull(creditPdModels.tenantId)
    : eq(creditPdModels.tenantId, tenantId);
  const [maxRow] = await db
    .select({ v: sql<number>`coalesce(max(${creditPdModels.version}), 0)::int` })
    .from(creditPdModels)
    .where(scopeWhere);
  const version = Number((maxRow as any)?.v ?? 0) + 1;
  await db.insert(creditPdModels).values({
    tenantId,
    weights: model.weights,
    featureNames: [...PD_FEATURE_NAMES],
    trainedAt: now,
    sampleCount: rows.length,
    logloss: model.logloss,
    auc: model.auc,
    version,
  });
  return {
    trained: true,
    sampleCount: rows.length,
    version,
    logloss: model.logloss,
    auc: model.auc,
    trainedAt: now,
  };
}

// ─── Scoring (never throws — rules fallback) ────────────────────────────────

export interface PdScoreResult {
  /** Probability of default, 0..1. */
  pd: number;
  confidence: number; // 0..1
  fallbackUsed: boolean;
  modelVersion: number | null;
  /** Which registry scope produced the score (null on rules fallback). */
  modelScope: "tenant" | "global" | null;
}

/**
 * ML probability-of-default for one buyer. NEVER throws: no model (tenant
 * or global) / malformed weights / any error → fallbackUsed=true with a PD
 * proxy derived from the rule score (pd = 1 − score/100). When
 * opts.ruleScore is provided (the scoring.ts integration already computed
 * it) it is used directly; otherwise the rule scorer is invoked lazily.
 */
export async function scorePd(
  db: TxHandle,
  tenantId: string,
  buyerId: string,
  opts: { now?: Date; ruleScore?: number } = {},
): Promise<PdScoreResult> {
  const now = opts.now ?? new Date();
  try {
    const resolved = await resolvePdModel(db, tenantId);
    if (resolved && resolved.model.weights.length === PD_FEATURE_NAMES.length + 1) {
      const x = await pdFeaturesForBuyer(db, buyerId, now);
      const z = logitOf(resolved.model.weights, x);
      const pd = sigmoid(z);
      const boundaryConfidence = Math.min(1, Math.abs(z) / 3);
      const sampleConfidence = Math.min(
        1,
        resolved.model.sampleCount / PD_MODEL_PARAMS.confidenceSampleSaturation,
      );
      const confidence = Math.round(boundaryConfidence * sampleConfidence * 1000) / 1000;
      return {
        pd,
        confidence,
        fallbackUsed: false,
        modelVersion: resolved.model.version,
        modelScope: resolved.source,
      };
    }
  } catch {
    // fall through to the rules proxy
  }
  return rulesPdFallback(db, tenantId, buyerId, opts);
}

/** Rule-based fallback: pd = 1 − ruleScore/100 (never throws). */
async function rulesPdFallback(
  db: TxHandle,
  tenantId: string,
  buyerId: string,
  opts: { now?: Date; ruleScore?: number },
): Promise<PdScoreResult> {
  try {
    let score = opts.ruleScore;
    if (score == null) {
      // Lazy import avoids a load-time cycle with scoring.ts (which calls
      // scorePd with ruleScore provided).
      const { suggestLimitTx } = await import("./scoring");
      const res = await suggestLimitTx(db, buyerId, tenantId, opts.now ?? new Date());
      score = res.score;
    }
    const pd = clamp01(1 - Math.max(0, Math.min(100, score)) / 100);
    return { pd, confidence: 0.3, fallbackUsed: true, modelVersion: null, modelScope: null };
  } catch {
    return { pd: 0.5, confidence: 0, fallbackUsed: true, modelVersion: null, modelScope: null };
  }
}

// ─── Cron entry point ───────────────────────────────────────────────────────

export interface PdModelTickSummary {
  tenants: number;
  trained: number;
  skipped: number;
  /** Global corpus model training outcome. */
  global: { trained: boolean; sampleCount: number };
}

/**
 * Scheduled training: retrain the global corpus model plus every supplier
 * tenant with credit accounts on its book. Per-tenant failures are isolated
 * and the function never throws (lead-model-tick wiring pattern).
 */
export async function runPdModelTick(db: TxHandle, now: Date = new Date()): Promise<PdModelTickSummary> {
  const summary: PdModelTickSummary = {
    tenants: 0,
    trained: 0,
    skipped: 0,
    global: { trained: false, sampleCount: 0 },
  };
  try {
    const g = await trainPdModelTx(db, null, now);
    summary.global = { trained: g.trained, sampleCount: g.sampleCount };
  } catch (err) {
    console.error("[pd-model-tick] global corpus failed:", err);
  }
  const tenantRows = await (db as any)
    .selectDistinct({ tenantId: creditAccounts.supplierTenantId })
    .from(creditAccounts);
  for (const t of tenantRows as any[]) {
    if (!t?.tenantId) continue;
    summary.tenants += 1;
    try {
      const r = await trainPdModelTx(db, t.tenantId, now);
      if (r.trained) summary.trained += 1;
      else summary.skipped += 1;
    } catch (err) {
      console.error(`[pd-model-tick] tenant ${t.tenantId} failed:`, err);
      summary.skipped += 1;
    }
  }
  return summary;
}

// Re-export so tests can assert the fail-open flag contract.
export { FLAG_UNAVAILABLE };
