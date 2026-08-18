/**
 * server/services/banditLimits.ts — W22 contextual-bandit credit-limit
 * setting, layered ON TOP of the rule-based scorer (tradeCredit/scoring.ts)
 * and the manufacturer program caps (manufacturerPrograms.ts).
 *
 * Mirrors the W20/W21 conventions (mlLeadScoring.ts / mlPdScoring.ts):
 *   - pure TypeScript, NO new npm dependencies,
 *   - deterministic (mulberry32 fixed seed for tie-breaking, rows sorted),
 *   - minimum-training gate (BANDIT_PARAMS.minRewardedDecisions),
 *   - registry/log table bandit_decisions (migration 0066),
 *   - never-throws contract with fallbackUsed flag (fallback = the
 *     rule-based baseline suggestion),
 *   - cron tick (runBanditRewardTick) wired as
 *     POST /api/scheduled/bandit-reward-tick (mirrors pd-model-tick).
 *
 * Model: LinUCB-style DISJOINT linear bandit. The action space is a small
 * set of multipliers on the rule-based suggestedLimitCents
 * (BANDIT_PARAMS.multipliers, e.g. [0.75, 1.0, 1.25, 1.5]). The context is
 * a normalized feature vector (BANDIT_FEATURE_NAMES: pd, utilization,
 * tenure, 90d volume — same signals the PD model reads) with a leading
 * bias term. Each arm keeps ridge-regularized sufficient statistics
 * (A = λI + Σxxᵀ, b = Σr·x) rebuilt from the tenant's rewarded decisions;
 * the UCB score is xᵀθ̂ + α·√(xᵀA⁻¹x). Ties are broken deterministically
 * with a fixed-seed mulberry32 draw over the tied arms.
 *
 * Reward: realized repayment outcome observed AFTER the decision —
 *   1   = repaid on time (draws settled, no dunning markers, balance 0),
 *   0.5 = late-cured (dunning markers but outstanding back to 0),
 *   0   = default (frozen account / draw overdue past the freeze horizon),
 * assigned by runBanditRewardTick to decisions whose reward is still NULL.
 *
 * Modes (banditMode):
 *   shadow (DEFAULT): the bandit logs what it WOULD choose into
 *     bandit_decisions; the applied limit is the rule-based baseline.
 *   active: ONLY when env BANDIT_LIMITS_MODE=active AND the tenant has
 *     ≥ minRewardedDecisions rewarded decisions. Even in active mode the
 *     chosen limit is clamped by the manufacturer program caps
 *     (maxExposure / remainingCapacity — hard constraints) passed in via
 *     opts.caps, and by the global FLOOR/CAP envelope.
 *
 * Money: integer cents everywhere; the multiplied limit is rounded to
 * whole ₦10 (1000 cents), mirroring the rule scorer.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { banditDecisions, creditAccounts, creditLedger } from "../../drizzle/schema";
import type { TxHandle } from "./tradeCredit/accounts";
import { CAP_LIMIT_CENTS, FLOOR_LIMIT_CENTS } from "./tradeCredit/scoring";
import { buyerPdSignalsTx } from "./tradeCredit/mlPdScoring";

// ─── Tunables (imported by tests — never hardcode elsewhere) ────────────────
export const BANDIT_PARAMS = {
  /** Deterministic PRNG seed for arm tie-breaking. */
  seed: 2025,
  /** UCB exploration weight α. */
  alpha: 1.0,
  /** Ridge regularization λ (A = λI + Σxxᵀ). */
  lambda: 1.0,
  /** Action space: multipliers on the rule-based suggested limit. */
  multipliers: [0.75, 1.0, 1.25, 1.5] as readonly number[],
  /** Active-mode gate: minimum REWARDED decisions for the tenant. */
  minRewardedDecisions: 100,
} as const;

/** Feature names, aligned with banditContext (bias term is prepended). */
export const BANDIT_FEATURE_NAMES = [
  "pd", // probability of default (ML PD or rule proxy), 0..1
  "utilization", // outstanding/limit clamped [0,1]
  "tenureDays", // min(days since first order, 365) / 365
  "volume90dLog", // log1p(90d GMV cents) / log1p(cap)
] as const;

const VOLUME_CAP_CENTS = 5_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LATE_MARKERS = ["[dun:fee]", "[dun:r+7]"] as const;
const FREEZE_OVERDUE_DAYS = 7;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Deterministic PRNG (mulberry32) — same construction as mlPdScoring. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Context ────────────────────────────────────────────────────────────────

export interface BanditContextInput {
  pd: number;
  utilization: number;
  tenureDays: number;
  volume90dCents: number;
}

/**
 * Normalized context vector: leading bias term (1) followed by the features
 * in BANDIT_FEATURE_NAMES order, all clamped to [0,1].
 */
export function banditContext(input: BanditContextInput): number[] {
  return [
    1,
    clamp01(Number.isFinite(input.pd) ? input.pd : 0.5),
    clamp01(input.utilization),
    clamp01(Math.min(Math.max(0, input.tenureDays), 365) / 365),
    clamp01(Math.log1p(Math.max(0, input.volume90dCents)) / Math.log1p(VOLUME_CAP_CENTS)),
  ];
}

export const BANDIT_CONTEXT_DIM = BANDIT_FEATURE_NAMES.length + 1;

/** Context for one buyer from the shared PD-signal extractor (never throws). */
export async function banditContextForBuyer(
  db: TxHandle,
  buyerTenantId: string,
  opts: { pd?: number; now?: Date } = {},
): Promise<number[]> {
  try {
    const sig = await buyerPdSignalsTx(db, buyerTenantId, opts.now ?? new Date());
    return banditContext({
      pd: opts.pd ?? (sig.hasHistory && sig.label != null ? sig.label : 0.5),
      utilization: sig.utilization,
      tenureDays: sig.tenureDays,
      volume90dCents: sig.volume90dCents,
    });
  } catch {
    return banditContext({ pd: opts.pd ?? 0.5, utilization: 0, tenureDays: 0, volume90dCents: 0 });
  }
}

// ─── Pure linear algebra (small fixed dimension — no deps) ──────────────────

/** Gauss-Jordan inverse of a small square matrix; returns null if singular. */
export function invertMatrix(a: number[][]): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const div = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

const matVec = (a: number[][], x: number[]) => a.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Normalize a stored/provided context to the fixed dimension. */
function dimContext(context: number[], d: number): number[] {
  return context.length >= d ? context.slice(0, d) : [...context, ...Array(d - context.length).fill(0)];
}

// ─── LinUCB arm selection ───────────────────────────────────────────────────

export interface BanditTrainingRow {
  /** Context vector at decision time (length BANDIT_CONTEXT_DIM). */
  context: number[];
  chosenMultiplier: number;
  reward: number;
}

export interface ArmChoice {
  armIndex: number;
  multiplier: number;
  /** UCB score per arm (aligned with BANDIT_PARAMS.multipliers). */
  scores: number[];
}

/**
 * LinUCB disjoint-arm selection. Per arm a: A_a = λI + Σ x xᵀ, b_a = Σ r x
 * over the rows where arm a was played; θ̂_a = A_a⁻¹ b_a; score =
 * xᵀθ̂_a + α√(xᵀA_a⁻¹x). Arms tied within 1e-9 of the max are broken
 * deterministically with a fixed-seed mulberry32 draw. Pure & deterministic.
 */
export function chooseArm(
  rows: BanditTrainingRow[],
  context: number[],
  opts: { seed?: number; alpha?: number; lambda?: number; multipliers?: readonly number[] } = {},
): ArmChoice {
  const multipliers = opts.multipliers ?? BANDIT_PARAMS.multipliers;
  const alpha = opts.alpha ?? BANDIT_PARAMS.alpha;
  const lambda = opts.lambda ?? BANDIT_PARAMS.lambda;
  const d = BANDIT_CONTEXT_DIM;
  const ctx = dimContext(context, d);

  const scores = multipliers.map((mult) => {
    const a: number[][] = Array.from({ length: d }, (_, i) =>
      Array.from({ length: d }, (_, j) => (i === j ? lambda : 0)),
    );
    const b = new Array<number>(d).fill(0);
    for (const r of rows) {
      if (r.chosenMultiplier !== mult) continue;
      const rx = dimContext(r.context, d);
      for (let i = 0; i < d; i++) {
        b[i] += r.reward * rx[i];
        for (let j = 0; j < d; j++) a[i][j] += rx[i] * rx[j];
      }
    }
    const inv = invertMatrix(a);
    if (!inv) return 0;
    const theta = matVec(inv, b);
    const invX = matVec(inv, ctx);
    const explore = Math.sqrt(Math.max(0, dot(ctx, invX)));
    return dot(ctx, theta) + alpha * explore;
  });

  const max = Math.max(...scores);
  const tied = scores.map((s, i) => (Math.abs(s - max) <= 1e-9 ? i : -1)).filter((i) => i >= 0);
  const rng = mulberry32(opts.seed ?? BANDIT_PARAMS.seed);
  const armIndex = tied[Math.floor(rng() * tied.length)] ?? 0;
  return { armIndex, multiplier: multipliers[armIndex], scores };
}

// ─── Money helpers ──────────────────────────────────────────────────────────

/**
 * Apply a multiplier to the rule-based baseline: integer cents, rounded to
 * whole ₦10 (1000¢) like the rule scorer, clamped to the global FLOOR/CAP
 * envelope and to any program caps (hard constraints — never exceeded, even
 * in active mode).
 */
export function applyMultiplier(
  baselineCents: number,
  multiplier: number,
  caps: { maxExposureCents?: number; remainingCapacityCents?: number } = {},
): number {
  const raw = Math.round((Math.max(0, baselineCents) * multiplier) / 1000) * 1000;
  let cents = Math.max(FLOOR_LIMIT_CENTS, Math.min(CAP_LIMIT_CENTS, raw));
  if (caps.maxExposureCents != null) cents = Math.min(cents, Math.max(0, Math.round(caps.maxExposureCents)));
  if (caps.remainingCapacityCents != null) cents = Math.min(cents, Math.max(0, Math.round(caps.remainingCapacityCents)));
  return Math.max(0, Math.round(cents));
}

/** Effective serving mode from the environment (documented in env.example.txt). */
export function banditMode(env: NodeJS.ProcessEnv = process.env): "shadow" | "active" {
  return String(env.BANDIT_LIMITS_MODE ?? "").toLowerCase() === "active" ? "active" : "shadow";
}

// ─── Decision logging + serving (never throws) ──────────────────────────────

export interface BanditSuggestResult {
  chosenMultiplier: number;
  armIndex: number;
  mode: "shadow" | "active";
  /** Limit to serve: bandit's cap-clamped choice in active mode, else the baseline. */
  suggestedLimitCents: number;
  /** Rule-based baseline the multiplier was applied to. */
  baselineLimitCents: number;
  /** The bandit's cap-clamped choice regardless of mode (logged in shadow). */
  banditLimitCents: number;
  fallbackUsed: boolean;
  /** bandit_decisions row id (null when the insert failed / fallback). */
  decisionId: string | null;
  context: number[];
}

async function loadRewardedRows(db: TxHandle, tenantId: string): Promise<BanditTrainingRow[]> {
  const rows = (await db
    .select({
      id: banditDecisions.id,
      context: banditDecisions.context,
      chosenMultiplier: banditDecisions.chosenMultiplier,
      reward: banditDecisions.reward,
      createdAt: banditDecisions.createdAt,
    })
    .from(banditDecisions)
    .where(and(eq(banditDecisions.tenantId, tenantId), isNotNull(banditDecisions.reward)))
    .orderBy(asc(banditDecisions.createdAt), asc(banditDecisions.id))) as any[];
  return rows
    .filter((r) => Array.isArray(r.context) && r.reward != null)
    .map((r) => ({
      context: (r.context as unknown[]).map((v) => Number(v)),
      chosenMultiplier: Number(r.chosenMultiplier),
      reward: Number(r.reward),
    }));
}

/**
 * Score a limit suggestion with the bandit and persist the decision row.
 * NEVER throws — any error returns the baseline with fallbackUsed=true.
 *
 * Shadow mode (default): logs what the bandit WOULD choose; the returned
 * suggestedLimitCents equals the (cap-clamped) baseline. Active mode
 * (BANDIT_LIMITS_MODE=active AND ≥ minRewardedDecisions rewarded decisions
 * for the tenant): serves the bandit's choice, ALWAYS clamped by opts.caps
 * (manufacturer program maxExposure / remainingCapacity are hard caps).
 */
export async function banditSuggestTx(
  db: TxHandle,
  args: {
    tenantId: string;
    buyerId: string;
    /** Rule-based suggested limit BEFORE program caps. */
    baselineLimitCents: number;
    /** Pre-computed PD (mlPdScoring/rule proxy); defaults to the signals. */
    pd?: number;
    context?: number[];
    caps?: { maxExposureCents?: number; remainingCapacityCents?: number };
    now?: Date;
  },
): Promise<BanditSuggestResult> {
  const fallback = (mode: "shadow" | "active"): BanditSuggestResult => ({
    chosenMultiplier: 1,
    armIndex: BANDIT_PARAMS.multipliers.indexOf(1),
    mode,
    suggestedLimitCents: applyMultiplier(args.baselineLimitCents, 1, args.caps),
    baselineLimitCents: args.baselineLimitCents,
    banditLimitCents: applyMultiplier(args.baselineLimitCents, 1, args.caps),
    fallbackUsed: true,
    decisionId: null,
    context: args.context ?? [],
  });
  try {
    const envMode = banditMode();
    const context =
      args.context ??
      (await banditContextForBuyer(db, args.buyerId, { pd: args.pd, now: args.now }));
    const rows = await loadRewardedRows(db, args.tenantId);
    const active = envMode === "active" && rows.length >= BANDIT_PARAMS.minRewardedDecisions;
    const mode: "shadow" | "active" = active ? "active" : "shadow";
    const choice = chooseArm(rows, context);
    const banditLimitCents = applyMultiplier(args.baselineLimitCents, choice.multiplier, args.caps);
    const baselineServed = applyMultiplier(args.baselineLimitCents, 1, args.caps);
    const [inserted] = (await db
      .insert(banditDecisions)
      .values({
        tenantId: args.tenantId,
        buyerId: args.buyerId,
        context,
        chosenMultiplier: choice.multiplier,
        suggestedLimitCents: banditLimitCents,
        baselineLimitCents: baselineServed,
        mode,
      })
      .returning({ id: banditDecisions.id })) as any[];
    return {
      chosenMultiplier: choice.multiplier,
      armIndex: choice.armIndex,
      mode,
      suggestedLimitCents: mode === "active" ? banditLimitCents : baselineServed,
      baselineLimitCents: baselineServed,
      banditLimitCents,
      fallbackUsed: false,
      decisionId: inserted?.id ?? null,
      context,
    };
  } catch {
    return fallback(banditMode());
  }
}

// ─── Reward assignment ──────────────────────────────────────────────────────

/**
 * Realized reward for one logged decision from the buyer's repayment
 * outcomes AFTER the decision was made:
 *   1   = a post-decision draw settled cleanly (no late markers),
 *   0.5 = late-cured (late markers but outstanding back at 0),
 *   0   = default (frozen account / posted draw overdue past the freeze
 *         horizon). Default dominates; unresolved books return null.
 */
export async function rewardForBuyerTx(
  db: TxHandle,
  buyerTenantId: string,
  since: Date,
  now: Date = new Date(),
): Promise<number | null> {
  const accounts = await db
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.buyerTenantId, buyerTenantId));
  let sawDefault = false;
  let sawCured = false;
  let sawOnTime = false;
  let unresolved = false;
  for (const account of accounts as any[]) {
    const rows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.creditAccountId, account.id));
    const draws = (rows as any[]).filter(
      (r) => r.kind === "invoice_draw" && r.status !== "void" && new Date(r.createdAt).getTime() >= since.getTime(),
    );
    if (draws.length === 0) continue;
    if (account.status === "frozen") sawDefault = true;
    for (const d of draws) {
      const late = LATE_MARKERS.some((m) => String(d.note ?? "").includes(m));
      const overdueDays = d.dueDate
        ? Math.floor((now.getTime() - new Date(d.dueDate).getTime()) / DAY_MS)
        : 0;
      if (d.status === "posted" && overdueDays > FREEZE_OVERDUE_DAYS) sawDefault = true;
      else if (late) {
        if (Number(account.outstandingCents) === 0 || d.status === "settled") sawCured = true;
        else unresolved = true;
      } else if (d.status === "settled") sawOnTime = true;
      else unresolved = true;
    }
  }
  if (sawDefault) return 0;
  if (sawCured) return 0.5;
  if (sawOnTime && !unresolved) return 1;
  return null;
}

export interface BanditRewardTickSummary {
  /** Decisions swept (reward still NULL at tick start). */
  swept: number;
  /** Decisions that received a reward this tick. */
  rewarded: number;
  /** Decisions still unresolved (open draws, no outcome yet). */
  pending: number;
  /** Reward histogram of the assignments made this tick. */
  histogram: { onTime: number; lateCured: number; defaulted: number };
}

/**
 * Cron sweep: assign rewards to bandit_decisions lacking one, from realized
 * repayment outcomes. Deterministic order (createdAt, id); per-decision
 * failures are isolated; never throws.
 */
export async function runBanditRewardTick(db: TxHandle, now: Date = new Date()): Promise<BanditRewardTickSummary> {
  const summary: BanditRewardTickSummary = {
    swept: 0,
    rewarded: 0,
    pending: 0,
    histogram: { onTime: 0, lateCured: 0, defaulted: 0 },
  };
  try {
    const pending = (await db
      .select()
      .from(banditDecisions)
      .where(isNull(banditDecisions.reward))
      .orderBy(asc(banditDecisions.createdAt), asc(banditDecisions.id))) as any[];
    for (const decision of pending) {
      summary.swept += 1;
      try {
        const reward = await rewardForBuyerTx(
          db,
          decision.buyerId,
          new Date(decision.createdAt),
          now,
        );
        if (reward == null) {
          summary.pending += 1;
          continue;
        }
        await db
          .update(banditDecisions)
          .set({ reward })
          .where(and(eq(banditDecisions.id, decision.id), isNull(banditDecisions.reward)));
        summary.rewarded += 1;
        if (reward === 1) summary.histogram.onTime += 1;
        else if (reward === 0.5) summary.histogram.lateCured += 1;
        else summary.histogram.defaulted += 1;
      } catch (err) {
        console.error(`[bandit-reward-tick] decision ${decision?.id} failed:`, err);
        summary.pending += 1;
      }
    }
  } catch (err) {
    console.error("[bandit-reward-tick] sweep failed:", err);
  }
  return summary;
}

// ─── Status + replay (router surface) ───────────────────────────────────────

export interface BanditStatus {
  /** Configured serving mode from BANDIT_LIMITS_MODE. */
  mode: "shadow" | "active";
  /** Whether active mode is actually served (env active AND gate met). */
  activeServing: boolean;
  minRewardedDecisions: number;
  multipliers: readonly number[];
  decisionsLogged: number;
  rewardedDecisions: number;
  /** rewarded/logged, 0 when no decisions. */
  rewardCoverage: number;
  lastDecisionAt: Date | null;
}

export async function banditStatusTx(db: TxHandle, tenantId: string): Promise<BanditStatus> {
  const rows = (await db
    .select({
      reward: banditDecisions.reward,
      createdAt: banditDecisions.createdAt,
    })
    .from(banditDecisions)
    .where(eq(banditDecisions.tenantId, tenantId))) as any[];
  const rewarded = rows.filter((r) => r.reward != null).length;
  const envMode = banditMode();
  const activeServing = envMode === "active" && rewarded >= BANDIT_PARAMS.minRewardedDecisions;
  return {
    mode: envMode,
    activeServing,
    minRewardedDecisions: BANDIT_PARAMS.minRewardedDecisions,
    multipliers: BANDIT_PARAMS.multipliers,
    decisionsLogged: rows.length,
    rewardedDecisions: rewarded,
    rewardCoverage: rows.length > 0 ? Math.round((rewarded / rows.length) * 1000) / 1000 : 0,
    lastDecisionAt: rows.reduce<Date | null>(
      (max, r) => (max == null || new Date(r.createdAt) > max ? new Date(r.createdAt) : max),
      null,
    ),
  };
}

export interface BanditReplay {
  /** Rewarded decisions where the current policy replays the logged arm. */
  matchedDecisions: number;
  /** Average reward on matched decisions (null when none matched). */
  banditAvgReward: number | null;
  /** Average reward of logged baseline-arm (×1.0) decisions. */
  baselineAvgReward: number | null;
  /** banditAvgReward − baselineAvgReward (null when either is missing). */
  lift: number | null;
  perMultiplier: Array<{ multiplier: number; decisions: number; avgReward: number | null }>;
}

/**
 * Off-policy estimate (rejection sampling): replay the current LinUCB policy
 * on each rewarded decision's stored context; decisions where the replayed
 * arm matches the logged arm form an unbiased-ish sample of the policy's
 * reward. Compared against the logged ×1.0 baseline arm. Deterministic.
 */
export async function banditReplayTx(db: TxHandle, tenantId: string): Promise<BanditReplay> {
  const rows = await loadRewardedRows(db, tenantId);
  const matchedRewards: number[] = [];
  const baselineRewards: number[] = [];
  for (const r of rows) {
    const choice = chooseArm(rows, r.context);
    if (choice.multiplier === r.chosenMultiplier) matchedRewards.push(r.reward);
    if (r.chosenMultiplier === 1) baselineRewards.push(r.reward);
  }
  const avg = (xs: number[]) =>
    xs.length > 0 ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 1000) / 1000 : null;
  const banditAvgReward = avg(matchedRewards);
  const baselineAvgReward = avg(baselineRewards);
  const perMultiplier = BANDIT_PARAMS.multipliers.map((m) => {
    const rs = rows.filter((r) => r.chosenMultiplier === m).map((r) => r.reward);
    return { multiplier: m, decisions: rs.length, avgReward: avg(rs) };
  });
  return {
    matchedDecisions: matchedRewards.length,
    banditAvgReward,
    baselineAvgReward,
    lift: banditAvgReward != null && baselineAvgReward != null
      ? Math.round((banditAvgReward - baselineAvgReward) * 1000) / 1000
      : null,
    perMultiplier,
  };
}
