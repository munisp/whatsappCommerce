/**
 * server/services/mlLeadScoring.ts — W20 ML propensity lead scoring.
 *
 * A per-tenant, dependency-free logistic-regression model layered ON TOP of
 * the rule-based lead score (server/services/leadScoring.ts). Same feature
 * philosophy (RFM + engagement + trade-credit behavior), but as a numeric
 * feature vector learned from the tenant's own order outcomes:
 *
 *   label    — did the customer order within LABEL_WINDOW_DAYS after the
 *              reference date (now − window)?
 *   features — recency / frequency(90d) / monetary(cents, log-scaled) /
 *              reply engagement / engagement recency / credit utilization,
 *              all normalized to [0,1] at the reference date.
 *
 * Training is full-batch gradient descent with L2 regularization, a fixed
 * deterministic seed and fixed iteration count (reproducible in tests).
 * Persisted in lead_score_models (migration 0061); each train bumps the
 * per-tenant version.
 *
 * Fallback contract: scoreCustomerMl NEVER throws. No trained model, below
 * the minimum-sample gate, missing customer, or any DB error →
 * { fallbackUsed: true } and the propensity is delegated to the rule-based
 * lead score (score/100). Cron wiring: /api/scheduled/lead-model-tick →
 * runLeadModelTick (mirrors the journey-tick pattern).
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  creditAccounts,
  customers,
  leadScoreModels,
  orders,
  whatsappCustomerReplies,
} from "../../drizzle/schema";
import {
  collectLeadSignals,
  computeLeadScore,
} from "./leadScoring";

// ─── Tunables (imported by tests — never hardcode elsewhere) ────────────────
export const ML_MODEL_PARAMS = {
  /** Deterministic PRNG seed for weight initialization. */
  seed: 1337,
  /** Fixed gradient-descent iterations. */
  iterations: 400,
  learningRate: 0.5,
  /** L2 penalty (not applied to the bias term). */
  l2: 0.001,
  /** Below this many labeled rows the model is NOT trained. */
  minTrainSamples: 50,
  /** Label: ordered within this many days after the reference date. */
  labelWindowDays: 14,
  /** sampleCount at which the sample-size confidence factor saturates. */
  confidenceSampleSaturation: 200,
} as const;

/** Feature names, aligned with the vector returned by featuresAsOf. */
export const ML_FEATURE_NAMES = [
  "recencyScore", // 1 at order today → 0 at ≥365d / never
  "frequency90d", // orders in last 90d, capped at 10
  "monetaryLogCents", // log1p(lifetime cents) / log1p(cap)
  "replyActivity90d", // inbound WhatsApp replies last 90d, capped at 20
  "engagementRecency", // 1 at inbound today → 0 at ≥90d / never
  "creditUtilization", // outstanding/limit clamped [0,1] (0 = no facility)
  "hasCreditFacility", // 1 if a credit account with a limit exists
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONETARY_CAP_CENTS = 5_000_000_000; // 50M major units → log scale cap
const FREQ_CAP = 10;
const REPLY_CAP = 20;

type Db = any;

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

export interface TrainingRow {
  x: number[]; // length ML_FEATURE_NAMES.length, values in [0,1]
  y: 0 | 1;
}

export interface TrainedModel {
  /** weights[0] is the bias; weights[i+1] multiplies feature i. */
  weights: number[];
  logloss: number;
}

export function predictPropensity(weights: number[], x: number[]): number {
  let z = weights[0] ?? 0;
  for (let i = 0; i < x.length; i++) z += (weights[i + 1] ?? 0) * x[i];
  return sigmoid(z);
}

export function logitOf(weights: number[], x: number[]): number {
  let z = weights[0] ?? 0;
  for (let i = 0; i < x.length; i++) z += (weights[i + 1] ?? 0) * x[i];
  return z;
}

export function meanLogLoss(weights: number[], rows: TrainingRow[], l2 = 0): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, predictPropensity(weights, r.x)));
    sum += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }
  let penalty = 0;
  for (let i = 1; i < weights.length; i++) penalty += weights[i] * weights[i];
  return sum / rows.length + (l2 / 2) * penalty;
}

/**
 * Full-batch gradient descent on log-loss with L2 regularization.
 * Deterministic: fixed seed → fixed initialization, fixed iteration count,
 * input order preserved (callers sort rows by customerId).
 */
export function trainLogisticRegression(
  rows: TrainingRow[],
  opts: { seed?: number; iterations?: number; learningRate?: number; l2?: number } = {},
): TrainedModel {
  const seed = opts.seed ?? ML_MODEL_PARAMS.seed;
  const iterations = opts.iterations ?? ML_MODEL_PARAMS.iterations;
  const lr = opts.learningRate ?? ML_MODEL_PARAMS.learningRate;
  const l2 = opts.l2 ?? ML_MODEL_PARAMS.l2;
  const nFeat = rows[0]?.x.length ?? ML_FEATURE_NAMES.length;

  const rng = mulberry32(seed);
  const weights = Array.from({ length: nFeat + 1 }, () => (rng() - 0.5) * 0.01);

  const n = rows.length;
  if (n === 0) return { weights, logloss: 0 };

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array<number>(weights.length).fill(0);
    for (const r of rows) {
      const err = predictPropensity(weights, r.x) - r.y;
      grad[0] += err;
      for (let i = 0; i < r.x.length; i++) grad[i + 1] += err * r.x[i];
    }
    weights[0] -= lr * (grad[0] / n);
    for (let i = 1; i < weights.length; i++) {
      weights[i] -= lr * (grad[i] / n + l2 * weights[i]);
    }
  }
  return { weights, logloss: meanLogLoss(weights, rows, l2) };
}

// ─── Feature extraction ─────────────────────────────────────────────────────

export interface CustomerRow {
  id: string;
  whatsappPhone: string | null;
  totalOrders: number;
  totalSpent: string | number;
  lastOrderAt: Date | null;
}

const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Numeric feature vector for one customer as of `asOf` (values in [0,1],
 * aligned with ML_FEATURE_NAMES). Reuses the rule-based signal philosophy —
 * recency/frequency/monetary from the order book, engagement from inbound
 * WhatsApp replies, credit behavior from credit_accounts — as numbers.
 */
export async function featuresAsOf(
  db: Db,
  tenantId: string,
  customer: CustomerRow,
  asOf: Date,
): Promise<number[]> {
  const since90 = new Date(asOf.getTime() - 90 * DAY_MS);

  const [freqRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customer.id),
      gte(orders.createdAt, since90),
      lt(orders.createdAt, asOf),
    ));

  const [lastOrderRow] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customer.id),
      lt(orders.createdAt, asOf),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  const lastOrderAt = (lastOrderRow as any)?.createdAt
    ? new Date((lastOrderRow as any).createdAt)
    : (customer.lastOrderAt && new Date(customer.lastOrderAt) < asOf ? new Date(customer.lastOrderAt) : null);

  // [monetaryRow] lifetime spend BEFORE asOf from the order book (integer
  // cents; customers.totalSpent is a cached decimal in major units and may
  // post-date asOf).
  const [monetaryRow] = await db
    .select({ cents: sql<number>`coalesce(sum((${orders.totalAmount})::numeric * 100), 0)::int` })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customer.id),
      lt(orders.createdAt, asOf),
    ));

  let replies90d = 0;
  let lastInbound: Date | null = null;
  if (customer.whatsappPhone) {
    const inbound = await db
      .select({ createdAt: whatsappCustomerReplies.createdAt })
      .from(whatsappCustomerReplies)
      .where(and(
        eq(whatsappCustomerReplies.tenantId, tenantId),
        eq(whatsappCustomerReplies.fromPhone, customer.whatsappPhone),
        lt(whatsappCustomerReplies.createdAt, asOf),
      ))
      .orderBy(desc(whatsappCustomerReplies.createdAt))
      .limit(REPLY_CAP + 1);
    const rows = inbound as any[];
    replies90d = rows.filter((r) => new Date(r.createdAt) >= since90).length;
    lastInbound = rows[0]?.createdAt ? new Date(rows[0].createdAt) : null;
  }

  // Outstanding-credit signal: accounts this tenant extended to the buyer.
  let creditUtilization = 0;
  let hasCreditFacility = 0;
  const accts = await db
    .select({ limit: creditAccounts.limitCents, outstanding: creditAccounts.outstandingCents })
    .from(creditAccounts)
    .where(eq(creditAccounts.supplierTenantId, tenantId));
  let limitSum = 0;
  let outstandingSum = 0;
  for (const a of accts as any[]) {
    limitSum += Number(a.limit ?? 0);
    outstandingSum += Number(a.outstanding ?? 0);
  }
  if (limitSum > 0) {
    hasCreditFacility = 1;
    creditUtilization = clamp01(outstandingSum / limitSum);
  }

  const recencyDays = lastOrderAt ? daysBetween(lastOrderAt, asOf) : 365;
  const monetaryCents = Math.max(0, Math.round(Number((monetaryRow as any)?.cents ?? 0)));
  return [
    1 - clamp01(Math.min(recencyDays, 365) / 365),
    clamp01(Math.min(Number((freqRow as any)?.n ?? 0), FREQ_CAP) / FREQ_CAP),
    clamp01(Math.log1p(monetaryCents) / Math.log1p(MONETARY_CAP_CENTS)),
    clamp01(Math.min(replies90d, REPLY_CAP) / REPLY_CAP),
    lastInbound ? 1 - clamp01(Math.min(daysBetween(lastInbound, asOf), 90) / 90) : 0,
    creditUtilization,
    hasCreditFacility,
  ];
}

// ─── Training-set construction ──────────────────────────────────────────────

/**
 * Labeled rows for one tenant. Reference date = now − labelWindowDays;
 * features are computed as-of that date, label = 1 iff the customer ordered
 * in (refDate, now]. Customers with no pre-reference order history are
 * excluded (nothing to learn from). Rows are sorted by customerId so
 * training is deterministic.
 */
export async function buildTrainingRows(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<TrainingRow[]> {
  const refDate = new Date(now.getTime() - ML_MODEL_PARAMS.labelWindowDays * DAY_MS);
  const custRows = await db
    .select({
      id: customers.id,
      whatsappPhone: customers.whatsappPhone,
      totalOrders: customers.totalOrders,
      totalSpent: customers.totalSpent,
      lastOrderAt: customers.lastOrderAt,
    })
    .from(customers)
    .where(eq(customers.tenantId, tenantId))
    .orderBy(customers.id);

  const rows: TrainingRow[] = [];
  for (const c of custRows as any[]) {
    const [preRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, c.id), lt(orders.createdAt, refDate)));
    const [postRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, c.id), gte(orders.createdAt, refDate)));
    if (Number((preRow as any)?.n ?? 0) === 0) continue; // no history → no label row
    const x = await featuresAsOf(db, tenantId, c, refDate);
    rows.push({ x, y: Number((postRow as any)?.n ?? 0) > 0 ? 1 : 0 });
  }
  return rows;
}

// ─── Model persistence ──────────────────────────────────────────────────────

export interface StoredModel {
  id: string;
  tenantId: string;
  weights: number[];
  featureNames: string[];
  trainedAt: Date;
  sampleCount: number;
  logloss: number | null;
  version: number;
}

/** Latest trained model for a tenant, or null when below the gate / never trained. */
export async function loadLatestModel(db: Db, tenantId: string): Promise<StoredModel | null> {
  const [row] = await db
    .select()
    .from(leadScoreModels)
    .where(eq(leadScoreModels.tenantId, tenantId))
    .orderBy(desc(leadScoreModels.version))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    weights: (row.weights as number[]) ?? [],
    featureNames: (row.featureNames as string[]) ?? [],
    trainedAt: row.trainedAt,
    sampleCount: row.sampleCount,
    logloss: row.logloss == null ? null : Number(row.logloss),
    version: row.version,
  };
}

export interface TrainResult {
  trained: boolean;
  reason?: "insufficient_samples";
  sampleCount: number;
  version: number | null;
  logloss: number | null;
  trainedAt: Date | null;
}

/**
 * Train + persist a new model version for the tenant. Below the
 * minimum-sample gate no row is written and trained=false is returned.
 */
export async function trainLeadModelTx(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<TrainResult> {
  const rows = await buildTrainingRows(db, tenantId, now);
  if (rows.length < ML_MODEL_PARAMS.minTrainSamples) {
    return { trained: false, reason: "insufficient_samples", sampleCount: rows.length, version: null, logloss: null, trainedAt: null };
  }
  const model = trainLogisticRegression(rows);
  const [maxRow] = await db
    .select({ v: sql<number>`coalesce(max(${leadScoreModels.version}), 0)::int` })
    .from(leadScoreModels)
    .where(eq(leadScoreModels.tenantId, tenantId));
  const version = Number((maxRow as any)?.v ?? 0) + 1;
  await db.insert(leadScoreModels).values({
    tenantId,
    weights: model.weights,
    featureNames: [...ML_FEATURE_NAMES],
    trainedAt: now,
    sampleCount: rows.length,
    logloss: model.logloss,
    version,
  });
  return { trained: true, sampleCount: rows.length, version, logloss: model.logloss, trainedAt: now };
}

// ─── Scoring (never throws — rules fallback) ────────────────────────────────

export interface MlScoreResult {
  propensity: number; // 0..1
  confidence: number; // 0..1
  fallbackUsed: boolean;
  modelVersion: number | null;
}

/** Rule-based fallback: propensity = explainable lead score / 100. */
async function rulesFallback(db: Db, tenantId: string, customerId: string, now: Date): Promise<MlScoreResult> {
  try {
    const [customer] = await db
      .select({
        id: customers.id,
        whatsappPhone: customers.whatsappPhone,
        totalOrders: customers.totalOrders,
        totalSpent: customers.totalSpent,
        lastOrderAt: customers.lastOrderAt,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    if (!customer) {
      return { propensity: 0, confidence: 0, fallbackUsed: true, modelVersion: null };
    }
    const signals = await collectLeadSignals(db, tenantId, customer, now);
    const { score } = computeLeadScore(signals);
    return { propensity: score / 100, confidence: 0.3, fallbackUsed: true, modelVersion: null };
  } catch {
    return { propensity: 0, confidence: 0, fallbackUsed: true, modelVersion: null };
  }
}

/**
 * ML propensity for one customer. NEVER throws: no model / below gate /
 * missing customer / any error → fallbackUsed=true with the rule-based score.
 * Confidence scales with distance from the decision boundary and the
 * training sample count.
 */
export async function scoreCustomerMl(
  db: Db,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<MlScoreResult> {
  try {
    const model = await loadLatestModel(db, tenantId);
    if (!model || model.weights.length !== ML_FEATURE_NAMES.length + 1) {
      return rulesFallback(db, tenantId, customerId, now);
    }
    const [customer] = await db
      .select({
        id: customers.id,
        whatsappPhone: customers.whatsappPhone,
        totalOrders: customers.totalOrders,
        totalSpent: customers.totalSpent,
        lastOrderAt: customers.lastOrderAt,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    if (!customer) return rulesFallback(db, tenantId, customerId, now);

    const x = await featuresAsOf(db, tenantId, customer, now);
    const z = logitOf(model.weights, x);
    const propensity = sigmoid(z);
    const boundaryConfidence = Math.min(1, Math.abs(z) / 3);
    const sampleConfidence = Math.min(1, model.sampleCount / ML_MODEL_PARAMS.confidenceSampleSaturation);
    const confidence = Math.round(boundaryConfidence * sampleConfidence * 1000) / 1000;
    return { propensity, confidence, fallbackUsed: false, modelVersion: model.version };
  } catch {
    return rulesFallback(db, tenantId, customerId, now);
  }
}

// ─── Cron entry point ───────────────────────────────────────────────────────

export interface LeadModelTickSummary {
  tenants: number;
  trained: number;
  skipped: number;
}

/**
 * Scheduled training across every tenant with customers. Per-tenant failures
 * are isolated and the function never throws (journey-tick wiring pattern).
 */
export async function runLeadModelTick(db: Db, now: Date = new Date()): Promise<LeadModelTickSummary> {
  const tenantRows = await db
    .selectDistinct({ tenantId: customers.tenantId })
    .from(customers);
  const summary: LeadModelTickSummary = { tenants: 0, trained: 0, skipped: 0 };
  for (const t of tenantRows as any[]) {
    if (!t?.tenantId) continue;
    summary.tenants += 1;
    try {
      const r = await trainLeadModelTx(db, t.tenantId, now);
      if (r.trained) summary.trained += 1;
      else summary.skipped += 1;
    } catch (err) {
      console.error(`[lead-model-tick] tenant ${t.tenantId} failed:`, err);
      summary.skipped += 1;
    }
  }
  return summary;
}
