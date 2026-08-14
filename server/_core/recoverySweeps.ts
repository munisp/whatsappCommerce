/**
 * Recovery sweeps runner (assurance F-02 remediation).
 *
 * Several recovery/reconciliation primitives existed as exported functions
 * with NO production invoker — recovery was designed but never
 * operationalized:
 *
 *   1. settlement_retry marker sweep — after a mandate charge succeeded but
 *      settlement was refused/failed, a durable `[settlement_retry]` marker
 *      row is written to credit_ledger (services/tradeCredit/capture.ts).
 *      Only an admin tRPC proc could retry it; money-moved-no-settlement
 *      could persist indefinitely.
 *   2. bureau retryFailedReports — re-sends pending/failed credit-bureau
 *      outbox rows (services/compliance/bureau.ts). No caller outside tests.
 *   3. dunning sweep — runDunningCheck applies reminders/late fees/freezes
 *      (services/tradeCredit/dunning.ts). Only simulation journeys called it.
 *   4. mandate-charge reconciler — reconcilePendingMandateCharges probes
 *      provider-side status for `pending` mandate_charges rows and settles
 *      exactly once (R2; services/tradeCredit/capture.ts).
 *   5. webhook-dedupe retention sweep — sweepProcessedWebhookEvents prunes
 *      the processed_webhook_events ledger (documented as a cron endpoint
 *      in webhookDedupe.ts but never wired).
 *
 * All five are IDEMPOTENT / claim-first by design (exactly-once guards,
 * marker claims, unique-index backstops), so overlapping or repeated runs
 * are safe.
 *
 * Invocation paths (both wired in _core/index.ts):
 *   - POST /api/internal/sweeps  — shared-secret gated (SWEEP_SECRET) for
 *     external schedulers (heartbeat/cron runners, k8s CronJob).
 *   - SWEEP_INTERVAL_MINUTES=N   — optional in-process interval scheduler
 *     for single-node deployments. DEFAULT OFF.
 *
 * Each sweep runs under per-sweep try/catch isolation: one throwing sweep
 * never stops the others. Every outcome (success metrics or failure) is
 * returned in a structured summary and failures are reported to the
 * observability sink via captureException.
 */
import { timingSafeEqual } from "crypto";
import { and, asc, eq, like } from "drizzle-orm";
import { creditLedger } from "../../drizzle/schema";
import { captureException } from "../services/observability";

export interface SweepOutcome {
  name: string;
  ok: boolean;
  durationMs: number;
  /** Sweep-specific structured metrics (counts settled/sent/pruned…). */
  summary: Record<string, unknown>;
  error?: string;
}

export interface NamedSweep {
  name: string;
  run: () => Promise<Record<string, unknown>>;
}

export interface SweepRunReport {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  results: SweepOutcome[];
}

const SETTLEMENT_RETRY_PREFIX = "[settlement_retry] ";

/**
 * Shared-secret gate for POST /api/internal/sweeps. FAIL-CLOSED: when
 * SWEEP_SECRET is unset/blank the endpoint is disabled ("disabled") — there
 * is NEVER a default secret. Otherwise the `x-sweep-secret` header is
 * compared timing-safe; mismatch/absence → "unauthorized".
 */
export function sweepEndpointAuth(
  headers: { [k: string]: unknown },
  env: NodeJS.ProcessEnv = process.env,
): "ok" | "disabled" | "unauthorized" {
  const secret = (env.SWEEP_SECRET ?? "").trim();
  if (!secret) return "disabled";
  const provided = String(headers["x-sweep-secret"] ?? "");
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "unauthorized";
  return "ok";
}

/**
 * Parse SWEEP_INTERVAL_MINUTES. Returns null when unset/invalid/<=0 —
 * the in-process scheduler is DEFAULT OFF and opt-in only.
 */
export function sweepIntervalMinutes(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = parseInt(env.SWEEP_INTERVAL_MINUTES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Generic plan runner: executes each sweep in order with per-sweep
 * try/catch isolation. Never throws. A failing sweep is captured as a
 * CRITICAL observability event and the remaining sweeps still run.
 */
export async function runSweepPlan(plan: NamedSweep[]): Promise<SweepRunReport> {
  const started = Date.now();
  const results: SweepOutcome[] = [];
  for (const sweep of plan) {
    const t0 = Date.now();
    try {
      const summary = (await sweep.run()) ?? {};
      results.push({ name: sweep.name, ok: true, durationMs: Date.now() - t0, summary });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      results.push({ name: sweep.name, ok: false, durationMs: Date.now() - t0, summary: {}, error: message });
      try {
        captureException(err, {
          service: "server/recoverySweeps",
          operation: `sweep:${sweep.name}`,
          severity: "critical",
        });
      } catch {
        console.error(`[recoverySweeps] sweep ${sweep.name} failed and captureException threw:`, message);
      }
    }
  }
  return {
    ok: results.every((r) => r.ok),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    results,
  };
}

/**
 * Scan credit_ledger for durable `[settlement_retry]` marker rows
 * (kind='adjustment', ref = repayment reference) and retry each one through
 * the claim-first `retrySettlement` primitive. Exactly-once is guaranteed
 * by the marker claim (DELETE … RETURNING) plus the 0052 unique index.
 */
export async function settlementRetryMarkerSweep(
  db: any,
  opts: { limit?: number; now?: Date } = {},
): Promise<{ scanned: number; settled: number; alreadySettled: number; refused: number; noPending: number }> {
  const { retrySettlement } = await import("../services/tradeCredit/capture");
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const markers = (await db
    .select({ accountId: creditLedger.creditAccountId, ref: creditLedger.ref })
    .from(creditLedger)
    .where(and(eq(creditLedger.kind, "adjustment"), like(creditLedger.note, `${SETTLEMENT_RETRY_PREFIX}%`)))
    .orderBy(asc(creditLedger.createdAt))
    .limit(limit)) as Array<{ accountId: string; ref: string | null }>;

  const out = { scanned: 0, settled: 0, alreadySettled: 0, refused: 0, noPending: 0 };
  const seen = new Set<string>();
  for (const m of markers) {
    if (!m.accountId || !m.ref) continue;
    const key = `${m.accountId}:${m.ref}`;
    if (seen.has(key)) continue; // duplicate marker rows → one retry per ref
    seen.add(key);
    out.scanned += 1;
    const res = await retrySettlement(db, { accountId: m.accountId, reference: m.ref }, opts.now ?? new Date());
    if (!res.ok) {
      if (res.status === "settlement_refused") out.refused += 1;
      else out.noPending += 1;
    } else if (res.status === "already_settled") out.alreadySettled += 1;
    else out.settled += 1;
  }
  return out;
}

/**
 * Build the default production sweep plan against a real db handle.
 * Kept separate from `runSweepPlan` so tests can inject fakes per sweep.
 */
export function buildDefaultSweepPlan(db: any, now: Date = new Date()): NamedSweep[] {
  return [
    {
      name: "settlement-retry",
      run: async () => ({ ...(await settlementRetryMarkerSweep(db, { now })) }),
    },
    {
      name: "mandate-charge-reconcile",
      run: async () => {
        const { reconcilePendingMandateCharges } = await import("../services/tradeCredit/capture");
        return { ...(await reconcilePendingMandateCharges(db, {}, now)) } as Record<string, unknown>;
      },
    },
    {
      name: "bureau-retry",
      run: async () => {
        const { retryFailedReports } = await import("../services/compliance/bureau");
        return { ...(await retryFailedReports(db)) } as Record<string, unknown>;
      },
    },
    {
      name: "dunning",
      run: async () => {
        const { runDunningCheckTx } = await import("../services/tradeCredit/dunning");
        return { ...(await runDunningCheckTx(db, now)) } as Record<string, unknown>;
      },
    },
    {
      name: "webhook-dedupe-retention",
      run: async () => {
        const { sweepProcessedWebhookEvents } = await import("../services/webhookDedupe");
        const deleted = await sweepProcessedWebhookEvents(db);
        return { deleted };
      },
    },
  ];
}

/**
 * Resolve a db handle (throws when the database is unavailable — the caller
 * maps that to 503) and run the full default sweep plan.
 */
export async function runRecoverySweeps(opts: { db?: any; now?: Date } = {}): Promise<SweepRunReport> {
  let db = opts.db;
  if (!db) {
    const { getDb } = await import("../db");
    db = await getDb();
  }
  if (!db) throw new Error("Database unavailable — cannot run recovery sweeps");
  return runSweepPlan(buildDefaultSweepPlan(db, opts.now ?? new Date()));
}
