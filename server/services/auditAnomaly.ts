/**
 * W20 — ML/statistical anomaly detection over the SOC2 audit stream.
 *
 * Pure TypeScript, no npm dependencies. Reads the tenant's audit_chain
 * window, compares it against per-tenant baselines learned from history, and
 * writes alerts to anomaly_alerts when the aggregate score crosses a
 * threshold.
 *
 * Signals (per tenant):
 *   1. event-type rate per hour-of-day — for each event type, the count in
 *      the scan window is compared against an EWMA baseline for that
 *      (eventType, hourOfDay) bucket; catches "off-hours purge/export".
 *   2. actor velocity — events per actor in the window vs the actor's EWMA
 *      baseline; catches scripted bulk actions from one account.
 *   3. sensitive-event rate — purge executions, retention upserts, customer
 *      data exports and incident creations vs their EWMA baseline.
 *
 * Scoring: each signal yields a robust z-score
 *   z = (observed − baselineMean) / max(1.4826 · MAD, MIN_SIGMA)
 * mapped to 0..1 via z / Z_CAP clamped; the aggregate anomaly score is the
 * maximum of the per-signal scores (any single strong signal is actionable).
 * Alert threshold defaults to DEFAULT_THRESHOLD (0.8) and is overridable via
 * the AUDIT_ANOMALY_THRESHOLD env var. Scores ≥ INCIDENT_SCORE (0.95) also
 * auto-open a critical incident (same insert shape as compliance router).
 *
 * Determinism: the clock is injectable (`opts.now`), so tests and journeys
 * are fully deterministic.
 *
 * Fail-open contract: scanAuditAnomaliesTx never throws. Any internal error
 * is swallowed and reported as { baselineBuilding: false, alertsCreated: 0,
 * error } so a detector bug can never break a compliance caller.
 *
 * Idempotency: alerts are keyed by (tenant_id, signal, window_bucket) with a
 * unique index + onConflictDoNothing, so re-scanning the same bucket never
 * duplicates an alert.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { anomalyAlerts, auditChain, incidents, type AuditChainRow } from "../../drizzle/schema";

// ── Tunables ────────────────────────────────────────────────────────────────
/** Minimum baseline-window events before scoring is possible (cold start). */
export const BASELINE_MIN_EVENTS = 20;
/** Default aggregate alert threshold (env AUDIT_ANOMALY_THRESHOLD overrides). */
export const DEFAULT_THRESHOLD = 0.8;
/** Score at/above which an incident is auto-opened. */
export const INCIDENT_SCORE = 0.95;
/** EWMA smoothing factor for baseline rates. */
export const EWMA_ALPHA = 0.3;
/** z-score that maps to an aggregate score of 1.0. */
export const Z_CAP = 6;
/** Floor for the dispersion estimate so near-constant baselines still alert on bursts. */
export const MIN_SIGMA = 0.5;
/** Baseline history length (ms) — 14 days of audit rows train the baselines. */
export const BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Default scan window — one hour. */
export const DEFAULT_SCAN_WINDOW_MS = 60 * 60 * 1000;

/** Event types treated as sensitive for the sensitive-rate signal. */
export const SENSITIVE_EVENT_TYPES = [
  "retention_purge",
  "retention_policy_upsert",
  "customer_data_export",
  "incident_created",
] as const;

export type AnomalySignal =
  | "event_type_rate_off_hours"
  | "actor_velocity"
  | "sensitive_event_rate";

export interface AnomalyScanOptions {
  /** Scan window length in ms (default 1h). */
  windowMs?: number;
  /** Injectable clock — determinism for tests/journeys. */
  now?: Date;
  /** Override the alert threshold (default: env AUDIT_ANOMALY_THRESHOLD or 0.8). */
  threshold?: number;
}

export interface AnomalyScanResult {
  baselineBuilding: boolean;
  baselineEvents: number;
  windowEvents: number;
  alertsCreated: number;
  alerts: Array<{ signal: AnomalySignal; score: number; id: string | null }>;
  incidentId?: string | null;
  error?: string;
}

type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

/** Resolved alert threshold (option override > env > default). */
export function alertThreshold(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) return clamp01(override);
  const raw = process.env.AUDIT_ANOMALY_THRESHOLD;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return clamp01(n);
  }
  return DEFAULT_THRESHOLD;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Hour-of-day bucket key (UTC) — 0..23. */
function hourOfDay(d: Date): number {
  return new Date(d).getUTCHours();
}

/** Median of a numeric array (0 for empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation around the median. */
function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * EWMA baseline: fold hourly bucket counts oldest→newest with EWMA_ALPHA.
 * Returns { mean, sigma } where sigma uses the robust 1.4826·MAD estimate
 * over the hourly counts, floored at MIN_SIGMA.
 */
function ewmaBaseline(hourlyCounts: number[]): { mean: number; sigma: number } {
  if (hourlyCounts.length === 0) return { mean: 0, sigma: MIN_SIGMA };
  let mean = hourlyCounts[0];
  for (let i = 1; i < hourlyCounts.length; i++) {
    mean = EWMA_ALPHA * hourlyCounts[i] + (1 - EWMA_ALPHA) * mean;
  }
  const sigma = Math.max(1.4826 * mad(hourlyCounts), MIN_SIGMA);
  return { mean, sigma };
}

/** Robust z → 0..1 score. */
function zScore(observed: number, mean: number, sigma: number): number {
  return clamp01(((observed - mean) / sigma) / Z_CAP);
}

/** Bucket start for idempotent alert keys. */
export function windowBucketStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Scan a tenant's audit stream for anomalies. Never throws (fail-open).
 *
 * Cold start: fewer than BASELINE_MIN_EVENTS events in the 14d baseline
 * window → { baselineBuilding: true } and no alerts are written.
 */
export async function scanAuditAnomaliesTx(
  db: DbLike,
  tenantId: string,
  opts: AnomalyScanOptions = {},
): Promise<AnomalyScanResult> {
  const windowMs = opts.windowMs ?? DEFAULT_SCAN_WINDOW_MS;
  const now = opts.now ?? new Date();
  const bucket = windowBucketStart(now, windowMs);
  try {
    const baselineFrom = new Date(bucket.getTime() - BASELINE_WINDOW_MS);
    const rows: AuditChainRow[] = await db
      .select()
      .from(auditChain)
      .where(and(eq(auditChain.tenantId, tenantId), gte(auditChain.createdAt, baselineFrom), lt(auditChain.createdAt, new Date(bucket.getTime() + windowMs))));

    const baselineRows = rows.filter((r) => new Date(r.createdAt).getTime() < bucket.getTime());
    const windowRows = rows.filter((r) => new Date(r.createdAt).getTime() >= bucket.getTime());

    const result: AnomalyScanResult = {
      baselineBuilding: false,
      baselineEvents: baselineRows.length,
      windowEvents: windowRows.length,
      alertsCreated: 0,
      alerts: [],
    };
    if (baselineRows.length < BASELINE_MIN_EVENTS) {
      result.baselineBuilding = true;
      return result;
    }

    // ── Hourly bucketization of the baseline ──────────────────────────────
    const hourMs = 60 * 60 * 1000;
    const bucketHour = hourOfDay(bucket);
    // Per event-type, per hour-of-day hourly count series.
    const typeHourSeries = new Map<string, number[]>(); // key `${type}|${hod}` → counts per hour slot
    const actorSeries = new Map<string, number[]>();
    const sensitiveSeries: number[] = [];
    const slots = Math.max(1, Math.ceil(BASELINE_WINDOW_MS / hourMs));
    const slotIndex = (t: number) => Math.floor((t - baselineFrom.getTime()) / hourMs);

    const initSeries = (map: Map<string, number[]>, key: string) => {
      if (!map.has(key)) map.set(key, new Array(slots).fill(0));
      return map.get(key)!;
    };
    const sensArr = new Array(slots).fill(0);
    for (const r of baselineRows) {
      const t = new Date(r.createdAt).getTime();
      const si = slotIndex(t);
      if (si < 0 || si >= slots) continue;
      initSeries(typeHourSeries, `${r.eventType}|${hourOfDay(new Date(r.createdAt))}`)[si] += 1;
      const actor = r.actorId ?? "(anonymous)";
      initSeries(actorSeries, actor)[si] += 1;
      if ((SENSITIVE_EVENT_TYPES as readonly string[]).includes(r.eventType)) sensArr[si] += 1;
    }
    sensitiveSeries.push(...sensArr);

    // ── Score each signal against the window ──────────────────────────────
    const scored: Array<{ signal: AnomalySignal; score: number; detail: Record<string, unknown> }> = [];

    // 1. event-type rate in this hour-of-day
    const typeCounts = new Map<string, number>();
    for (const r of windowRows) {
      if (hourOfDay(new Date(r.createdAt)) !== bucketHour) continue;
      typeCounts.set(r.eventType, (typeCounts.get(r.eventType) ?? 0) + 1);
    }
    let bestType: { score: number; detail: Record<string, unknown> } | null = null;
    for (const [type, observed] of Array.from(typeCounts)) {
      const series = typeHourSeries.get(`${type}|${bucketHour}`) ?? new Array(slots).fill(0);
      const { mean, sigma } = ewmaBaseline(series);
      const score = zScore(observed, mean, sigma);
      if (!bestType || score > bestType.score) {
        bestType = { score, detail: { eventType: type, hourOfDay: bucketHour, observed, baselineMean: mean, baselineSigma: sigma } };
      }
    }
    if (bestType) scored.push({ signal: "event_type_rate_off_hours", ...bestType });

    // 2. actor velocity
    const actorCounts = new Map<string, number>();
    for (const r of windowRows) {
      const actor = r.actorId ?? "(anonymous)";
      actorCounts.set(actor, (actorCounts.get(actor) ?? 0) + 1);
    }
    let bestActor: { score: number; detail: Record<string, unknown> } | null = null;
    for (const [actor, observed] of Array.from(actorCounts)) {
      const { mean, sigma } = ewmaBaseline(actorSeries.get(actor) ?? new Array(slots).fill(0));
      const score = zScore(observed, mean, sigma);
      if (!bestActor || score > bestActor.score) {
        bestActor = { score, detail: { actorId: actor, observed, baselineMean: mean, baselineSigma: sigma } };
      }
    }
    if (bestActor) scored.push({ signal: "actor_velocity", ...bestActor });

    // 3. sensitive-event rate
    const sensitiveObserved = windowRows.filter((r) => (SENSITIVE_EVENT_TYPES as readonly string[]).includes(r.eventType)).length;
    if (sensitiveObserved > 0) {
      const { mean, sigma } = ewmaBaseline(sensitiveSeries);
      scored.push({
        signal: "sensitive_event_rate",
        score: zScore(sensitiveObserved, mean, sigma),
        detail: {
          observed: sensitiveObserved,
          baselineMean: mean,
          baselineSigma: sigma,
          eventTypes: windowRows
            .filter((r) => (SENSITIVE_EVENT_TYPES as readonly string[]).includes(r.eventType))
            .map((r) => r.eventType),
        },
      });
    }

    // ── Persist alerts over threshold (idempotent per signal+bucket) ──────
    const threshold = alertThreshold(opts.threshold);
    let topScore = 0;
    for (const s of scored) {
      topScore = Math.max(topScore, s.score);
      if (s.score < threshold) continue;
      const inserted = await db
        .insert(anomalyAlerts)
        .values({
          tenantId,
          signal: s.signal,
          score: s.score,
          detail: { ...s.detail, windowMs } as any,
          status: "open",
          windowBucket: bucket,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      result.alerts.push({ signal: s.signal, score: s.score, id: row?.id ?? null });
      if (row?.id) result.alertsCreated += 1;
    }

    // ── Auto-open a critical incident for extreme scores ─────────────────
    if (topScore >= INCIDENT_SCORE) {
      const ins = await db.insert(incidents).values({
        tenantId,
        severity: "critical",
        title: `Audit anomaly detected (score ${topScore.toFixed(2)})`,
        description: `Automated anomaly scan flagged the audit stream in window starting ${bucket.toISOString()}. See anomaly_alerts for detail.`,
        status: "open",
        openedAt: now,
      }).returning();
      const inc = Array.isArray(ins) ? ins[0] : ins;
      result.incidentId = inc?.id ?? null;
    }

    return result;
  } catch (e: any) {
    // Fail-open: detector errors must never break callers.
    return {
      baselineBuilding: false,
      baselineEvents: 0,
      windowEvents: 0,
      alertsCreated: 0,
      alerts: [],
      error: String(e?.message ?? e),
    };
  }
}
