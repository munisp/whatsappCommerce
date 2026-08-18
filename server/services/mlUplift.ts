/**
 * server/services/mlUplift.ts — W21 two-model uplift scoring for broadcast
 * targeting, layered ON TOP of the rule-based segment heuristics
 * (routers/broadcast.matchesSegment). Same feature philosophy as
 * mlLeadScoring (RFM + engagement as numbers), but TWO per-tenant logistic
 * regressions:
 *
 *   treatment model — P(purchase | received broadcast), trained on customers
 *     who received a prior broadcast/win-back message (broadcast_recipients
 *     status 'sent') before the reference date;
 *   control model   — P(purchase | no message), trained on comparable
 *     customers never messaged before the reference date.
 *
 *   label    — ordered within UPLIFT_MODEL_PARAMS.labelWindowDays after the
 *              reference date (now − window);
 *   uplift   — pTreatment − pControl, clamped to [−1, 1].
 *
 * Training is the same deterministic full-batch gradient descent as
 * mlLeadScoring (fixed seed, fixed iterations — reused from that module, no
 * new dependencies). Persisted in uplift_models (migration 0064), one row
 * per (tenant, role, version); each train bumps the per-tenant version for
 * BOTH arms together.
 *
 * Fallback contract: scoreUplift NEVER throws. Untrained (either arm below
 * the min-sample gate), missing customer, or any DB error →
 * { uplift: null, fallbackUsed: true } and broadcast targeting keeps the
 * rule-based noOrderSinceDays heuristic. Cron wiring:
 * /api/scheduled/uplift-model-tick → runUpliftModelTick (mirrors
 * lead-model-tick).
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  broadcastCampaigns,
  broadcastRecipients,
  customers,
  orders,
  upliftModels,
  whatsappCustomerReplies,
} from "../../drizzle/schema";
import {
  meanLogLoss,
  predictPropensity,
  sigmoid,
  trainLogisticRegression,
  type TrainingRow,
} from "./mlLeadScoring";

// ─── Tunables (imported by tests — never hardcode elsewhere) ────────────────
export const UPLIFT_MODEL_PARAMS = {
  /** Deterministic PRNG seed offset (treatment = seed, control = seed + 1). */
  seed: 2027,
  /** Fixed gradient-descent iterations. */
  iterations: 400,
  learningRate: 0.5,
  /** L2 penalty (not applied to the bias term). */
  l2: 0.001,
  /** Below this many labeled rows PER ARM the models are NOT trained. */
  minTrainSamplesPerArm: 40,
  /** Label: ordered within this many days after the reference date. */
  labelWindowDays: 14,
  /** Minimum uplift for a customer to be kept when rankByUplift is on. */
  upliftThreshold: 0.05,
  /** sampleCount (smaller arm) at which the sample confidence saturates. */
  confidenceSampleSaturation: 200,
} as const;

/** Feature names, aligned with the vector returned by upliftFeaturesAsOf. */
export const UPLIFT_FEATURE_NAMES = [
  "recencyScore", // 1 at order today → 0 at ≥365d / never
  "frequency90d", // orders in last 90d, capped at 10
  "monetaryLogCents", // log1p(lifetime cents) / log1p(cap)
  "replyRate", // inbound replies per broadcast received, capped at 5
  "daysSinceLastOrderNorm", // min(days, 365)/365 (1 = very cold / never)
] as const;

export type UpliftRole = "treatment" | "control";
export const UPLIFT_ROLES: readonly UpliftRole[] = ["treatment", "control"];

const DAY_MS = 24 * 60 * 60 * 1000;
const MONETARY_CAP_CENTS = 5_000_000_000;
const FREQ_CAP = 10;
const REPLY_RATE_CAP = 5;

type Db = any;

const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// ─── Feature extraction ─────────────────────────────────────────────────────

export interface UpliftCustomerRow {
  id: string;
  whatsappPhone: string | null;
  totalOrders: number;
  totalSpent: string | number;
  lastOrderAt: Date | null;
}

/**
 * Numeric feature vector for one customer as of `asOf` (values in [0,1],
 * aligned with UPLIFT_FEATURE_NAMES). replyRate = inbound WhatsApp replies
 * (lifetime, before asOf) divided by broadcasts received (before asOf),
 * capped — 0 for never-messaged customers.
 */
export async function upliftFeaturesAsOf(
  db: Db,
  tenantId: string,
  customer: UpliftCustomerRow,
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

  const [monetaryRow] = await db
    .select({ cents: sql<number>`coalesce(sum((${orders.totalAmount})::numeric * 100), 0)::int` })
    .from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.customerId, customer.id),
      lt(orders.createdAt, asOf),
    ));

  let replyRate = 0;
  if (customer.whatsappPhone) {
    const phone = customer.whatsappPhone;
    const [replyRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(whatsappCustomerReplies)
      .where(and(
        eq(whatsappCustomerReplies.tenantId, tenantId),
        eq(whatsappCustomerReplies.fromPhone, phone),
        lt(whatsappCustomerReplies.createdAt, asOf),
      ));
    const [msgRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(broadcastRecipients)
      .innerJoin(broadcastCampaigns, eq(broadcastRecipients.campaignId, broadcastCampaigns.id))
      .where(and(
        eq(broadcastCampaigns.tenantId, tenantId),
        eq(broadcastRecipients.phone, phone),
        eq(broadcastRecipients.status, "sent"),
        lt(broadcastRecipients.createdAt, asOf),
      ));
    const replies = Number((replyRow as any)?.n ?? 0);
    const messages = Number((msgRow as any)?.n ?? 0);
    if (messages > 0) replyRate = clamp01(Math.min(replies / messages, REPLY_RATE_CAP) / REPLY_RATE_CAP);
  }

  const recencyDays = lastOrderAt ? daysBetween(lastOrderAt, asOf) : 365;
  const monetaryCents = Math.max(0, Math.round(Number((monetaryRow as any)?.cents ?? 0)));
  return [
    1 - clamp01(Math.min(recencyDays, 365) / 365),
    clamp01(Math.min(Number((freqRow as any)?.n ?? 0), FREQ_CAP) / FREQ_CAP),
    clamp01(Math.log1p(monetaryCents) / Math.log1p(MONETARY_CAP_CENTS)),
    replyRate,
    clamp01(Math.min(recencyDays, 365) / 365),
  ];
}

// ─── Training-set construction ──────────────────────────────────────────────

export interface UpliftTrainingSets {
  treatment: TrainingRow[];
  control: TrainingRow[];
}

/**
 * Labeled rows for one tenant, per arm. Reference date = now −
 * labelWindowDays; features as-of that date; label = 1 iff the customer
 * ordered in (refDate, now]. Treatment arm = customers with ≥1 sent
 * broadcast_recipients row before refDate; control arm = customers with
 * NONE. Customers with no pre-reference order history are excluded from
 * both arms. Rows are sorted by customerId (deterministic training).
 */
export async function buildUpliftTrainingSets(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<UpliftTrainingSets> {
  const refDate = new Date(now.getTime() - UPLIFT_MODEL_PARAMS.labelWindowDays * DAY_MS);

  // Phones that received a sent broadcast before the reference date.
  const messaged = await db
    .select({ phone: broadcastRecipients.phone })
    .from(broadcastRecipients)
    .innerJoin(broadcastCampaigns, eq(broadcastRecipients.campaignId, broadcastCampaigns.id))
    .where(and(
      eq(broadcastCampaigns.tenantId, tenantId),
      eq(broadcastRecipients.status, "sent"),
      lt(broadcastRecipients.createdAt, refDate),
    ));
  const messagedPhones = new Set((messaged as any[]).map((r) => String(r.phone)));

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

  const sets: UpliftTrainingSets = { treatment: [], control: [] };
  for (const c of custRows as any[]) {
    const [preRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, c.id), lt(orders.createdAt, refDate)));
    if (Number((preRow as any)?.n ?? 0) === 0) continue; // no history → no label row
    const [postRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, c.id), gte(orders.createdAt, refDate)));
    const x = await upliftFeaturesAsOf(db, tenantId, c, refDate);
    const row: TrainingRow = { x, y: Number((postRow as any)?.n ?? 0) > 0 ? 1 : 0 };
    if (c.whatsappPhone && messagedPhones.has(String(c.whatsappPhone))) sets.treatment.push(row);
    else sets.control.push(row);
  }
  return sets;
}

// ─── Model persistence ──────────────────────────────────────────────────────

export interface StoredUpliftModel {
  id: string;
  tenantId: string;
  role: UpliftRole;
  weights: number[];
  featureNames: string[];
  trainedAt: Date;
  sampleCount: number;
  logloss: number | null;
  version: number;
}

/** Latest model per role for a tenant (null role entry when untrained). */
export async function loadLatestModels(
  db: Db,
  tenantId: string,
): Promise<Record<UpliftRole, StoredUpliftModel | null>> {
  const rows = await db
    .select()
    .from(upliftModels)
    .where(eq(upliftModels.tenantId, tenantId))
    .orderBy(desc(upliftModels.version));
  const out: Record<UpliftRole, StoredUpliftModel | null> = { treatment: null, control: null };
  for (const row of rows as any[]) {
    const role = row.role as UpliftRole;
    if (out[role]) continue; // rows are version-desc — first per role is latest
    out[role] = {
      id: row.id,
      tenantId: row.tenantId,
      role,
      weights: (row.weights as number[]) ?? [],
      featureNames: (row.featureNames as string[]) ?? [],
      trainedAt: row.trainedAt,
      sampleCount: row.sampleCount,
      logloss: row.logloss == null ? null : Number(row.logloss),
      version: row.version,
    };
  }
  return out;
}

export interface UpliftTrainResult {
  trained: boolean;
  reason?: "insufficient_samples";
  treatmentSamples: number;
  controlSamples: number;
  version: number | null;
  treatmentLogloss: number | null;
  controlLogloss: number | null;
  trainedAt: Date | null;
}

/**
 * Train + persist BOTH arms at a new shared version for the tenant. When
 * either arm is below the per-arm minimum-sample gate no rows are written
 * and trained=false is returned.
 */
export async function trainUpliftModelsTx(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<UpliftTrainResult> {
  const sets = await buildUpliftTrainingSets(db, tenantId, now);
  const base = {
    treatmentSamples: sets.treatment.length,
    controlSamples: sets.control.length,
  };
  if (
    sets.treatment.length < UPLIFT_MODEL_PARAMS.minTrainSamplesPerArm ||
    sets.control.length < UPLIFT_MODEL_PARAMS.minTrainSamplesPerArm
  ) {
    return {
      trained: false, reason: "insufficient_samples", ...base,
      version: null, treatmentLogloss: null, controlLogloss: null, trainedAt: null,
    };
  }

  const treatment = trainLogisticRegression(sets.treatment, {
    seed: UPLIFT_MODEL_PARAMS.seed,
    iterations: UPLIFT_MODEL_PARAMS.iterations,
    learningRate: UPLIFT_MODEL_PARAMS.learningRate,
    l2: UPLIFT_MODEL_PARAMS.l2,
  });
  const control = trainLogisticRegression(sets.control, {
    seed: UPLIFT_MODEL_PARAMS.seed + 1,
    iterations: UPLIFT_MODEL_PARAMS.iterations,
    learningRate: UPLIFT_MODEL_PARAMS.learningRate,
    l2: UPLIFT_MODEL_PARAMS.l2,
  });

  const [maxRow] = await db
    .select({ v: sql<number>`coalesce(max(${upliftModels.version}), 0)::int` })
    .from(upliftModels)
    .where(eq(upliftModels.tenantId, tenantId));
  const version = Number((maxRow as any)?.v ?? 0) + 1;

  for (const [role, model, sampleCount] of [
    ["treatment", treatment, sets.treatment.length],
    ["control", control, sets.control.length],
  ] as const) {
    await db.insert(upliftModels).values({
      tenantId,
      role,
      weights: model.weights,
      featureNames: [...UPLIFT_FEATURE_NAMES],
      trainedAt: now,
      sampleCount,
      logloss: model.logloss,
      version,
    });
  }
  return {
    trained: true, ...base, version,
    treatmentLogloss: treatment.logloss, controlLogloss: control.logloss, trainedAt: now,
  };
}

// ─── Scoring (never throws — heuristic fallback) ────────────────────────────

export interface UpliftScoreResult {
  /** pTreatment − pControl in [−1,1]; null when the fallback was used. */
  uplift: number | null;
  confidence: number; // 0..1
  fallbackUsed: boolean;
  modelVersion: number | null;
}

const UPLIFT_FALLBACK: UpliftScoreResult = {
  uplift: null,
  confidence: 0,
  fallbackUsed: true,
  modelVersion: null,
};

/**
 * Uplift score for one customer. NEVER throws: no trained arm / malformed
 * weights / missing customer / any error → uplift=null, fallbackUsed=true.
 * Confidence scales with the arm sample sizes and the separation between
 * the two arm predictions.
 */
export async function scoreUplift(
  db: Db,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<UpliftScoreResult> {
  try {
    const models = await loadLatestModels(db, tenantId);
    const t = models.treatment;
    const c = models.control;
    if (
      !t || !c ||
      t.weights.length !== UPLIFT_FEATURE_NAMES.length + 1 ||
      c.weights.length !== UPLIFT_FEATURE_NAMES.length + 1 ||
      t.version !== c.version
    ) {
      return { ...UPLIFT_FALLBACK };
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
    if (!customer) return { ...UPLIFT_FALLBACK };

    const x = await upliftFeaturesAsOf(db, tenantId, customer, now);
    const pT = predictPropensity(t.weights, x);
    const pC = predictPropensity(c.weights, x);
    const uplift = Math.min(1, Math.max(-1, pT - pC));
    const sampleConfidence = Math.min(
      1,
      Math.min(t.sampleCount, c.sampleCount) / UPLIFT_MODEL_PARAMS.confidenceSampleSaturation,
    );
    const separationConfidence = Math.min(1, Math.abs(pT - pC) / 0.25);
    const confidence = Math.round(sampleConfidence * separationConfidence * 1000) / 1000;
    return { uplift, confidence, fallbackUsed: false, modelVersion: t.version };
  } catch {
    return { ...UPLIFT_FALLBACK };
  }
}

// ─── Batch ranking for broadcast targeting ──────────────────────────────────

export interface UpliftRankedMember<T> {
  member: T;
  uplift: number;
  confidence: number;
}

/**
 * Rank broadcast candidates by modeled uplift: only customers with uplift >
 * UPLIFT_MODEL_PARAMS.upliftThreshold are kept, highest uplift first.
 * Returns null when the tenant has no trained arm pair — callers must then
 * fall back to the rule-based segment heuristic unchanged. Never throws.
 */
export async function rankByUpliftOrNull<T extends { customerId: string }>(
  db: Db,
  tenantId: string,
  members: T[],
  now: Date = new Date(),
): Promise<UpliftRankedMember<T>[] | null> {
  try {
    const models = await loadLatestModels(db, tenantId);
    const t = models.treatment;
    const c = models.control;
    if (
      !t || !c ||
      t.weights.length !== UPLIFT_FEATURE_NAMES.length + 1 ||
      c.weights.length !== UPLIFT_FEATURE_NAMES.length + 1 ||
      t.version !== c.version
    ) {
      return null;
    }
    const customerIds = members.map((m) => m.customerId);
    if (customerIds.length === 0) return [];
    const rows = await db
      .select({
        id: customers.id,
        whatsappPhone: customers.whatsappPhone,
        totalOrders: customers.totalOrders,
        totalSpent: customers.totalSpent,
        lastOrderAt: customers.lastOrderAt,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), inArray(customers.id, customerIds)));
    const byId = new Map((rows as any[]).map((r) => [r.id, r]));
    const scored: UpliftRankedMember<T>[] = [];
    for (const m of members) {
      const cust = byId.get(m.customerId);
      if (!cust) continue;
      const x = await upliftFeaturesAsOf(db, tenantId, cust, now);
      const uplift = Math.min(1, Math.max(-1,
        predictPropensity(t.weights, x) - predictPropensity(c.weights, x)));
      if (uplift <= UPLIFT_MODEL_PARAMS.upliftThreshold) continue;
      const sampleConfidence = Math.min(
        1,
        Math.min(t.sampleCount, c.sampleCount) / UPLIFT_MODEL_PARAMS.confidenceSampleSaturation,
      );
      scored.push({ member: m, uplift, confidence: Math.round(sampleConfidence * 1000) / 1000 });
    }
    // Deterministic order: uplift desc, then customerId asc.
    scored.sort((a, b) => b.uplift - a.uplift || a.member.customerId.localeCompare(b.member.customerId));
    return scored;
  } catch {
    return null;
  }
}

// ─── Cron entry point ───────────────────────────────────────────────────────

export interface UpliftModelTickSummary {
  tenants: number;
  trained: number;
  skipped: number;
}

/**
 * Scheduled training across every tenant with customers. Per-tenant
 * failures are isolated and the function never throws (journey-tick wiring
 * pattern).
 */
export async function runUpliftModelTick(db: Db, now: Date = new Date()): Promise<UpliftModelTickSummary> {
  const tenantRows = await db
    .selectDistinct({ tenantId: customers.tenantId })
    .from(customers);
  const summary: UpliftModelTickSummary = { tenants: 0, trained: 0, skipped: 0 };
  for (const t of tenantRows as any[]) {
    if (!t?.tenantId) continue;
    summary.tenants += 1;
    try {
      const r = await trainUpliftModelsTx(db, t.tenantId, now);
      if (r.trained) summary.trained += 1;
      else summary.skipped += 1;
    } catch (err) {
      console.error(`[uplift-model-tick] tenant ${t.tenantId} failed:`, err);
      summary.skipped += 1;
    }
  }
  return summary;
}

// Re-exported so callers/tests can assert training quality without a second
// import surface.
export { meanLogLoss, sigmoid };
