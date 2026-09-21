/**
 * QA-040: load shedding — refuse work we cannot finish, quickly, instead of queueing it until it is useless.
 *
 * Measured on the local stack (`.qa/perf/summary.md`): one Node process saturates at ~1.1–1.3k RPS, and past that every
 * extra request just joins a queue — p99 reached 13.3 s at 800 concurrent (p95 was 490 ms), and 2.8 s at a 400-wide
 * spike. A client that waits 13 s has usually given up already, so the work is done for nothing AND it made everyone
 * else slower. An honest, immediate `503 + Retry-After` for a fraction of requests keeps the tail bounded for the rest.
 *
 * WHY EVENT-LOOP LAG, and not "number of requests in flight": in-flight counts are wrong here in both directions.
 * This server holds legitimately long-lived requests (SSE streams, slow uploads, provider callbacks awaiting a DB), which
 * would eat a concurrency budget while costing no CPU — and a CPU-bound burst can starve the process at a small
 * in-flight count. Event-loop delay is the thing that actually goes wrong (every request's latency is inflated by it),
 * so that is what we measure.
 *
 * WHAT IS NEVER SHED (`isLoadShedExempt`): health probes (shedding them makes Kubernetes pull a busy-but-alive pod out
 * of rotation, turning overload into an outage), the metrics scrape (you must be able to SEE the overload),
 * payment/messaging provider webhooks and integration callbacks (money confirmations — capacity there is already
 * governed by the edge rate limiter), and internal/scheduled callers (a shed cron run is a missed run).
 *
 * Fail-open by construction: if the lag sampler is unavailable the middleware sheds nothing.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

/** Paths whose requests must always be served. Prefix matches include the trailing slash so `/api/webhooks-x` is NOT exempt. */
export const LOAD_SHED_EXEMPT_PREFIXES = [
  "/api/metrics",
  "/api/webhooks/",
  "/integrations/",
  "/api/internal/",
  "/api/scheduled/",
] as const;

export function isLoadShedExempt(path: string): boolean {
  // A path that tries to climb out of an exempt prefix is not that prefix.
  if (path.includes("..")) return false;
  if (path === "/health" || path.startsWith("/health/")) return true;
  return LOAD_SHED_EXEMPT_PREFIXES.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/**
 * Fraction of non-exempt requests to refuse at a given event-loop lag: 0 up to `startMs`, 1 from `allMs`, linear
 * between. Proportional rather than on/off so a mild overload sheds a little instead of flapping between "all" and "none".
 * Anything that is not a sane number (NaN, undefined-as-NaN) sheds nothing — fail open.
 */
export function shedProbability(lagMs: number, startMs: number, allMs: number): number {
  if (!(lagMs > startMs)) return 0;
  if (!(allMs > startMs)) return 0; // misconfigured window: never divide by zero, never shed
  if (lagMs >= allMs) return 1;
  return (lagMs - startMs) / (allMs - startMs);
}

export interface LoadShedOptions {
  /** Current event-loop lag in ms (see `startEventLoopLagSampler`). Injected so tests are deterministic. */
  lagMs: () => number;
  /** Lag at which shedding starts. Default 200 ms — several times the healthy p99 measured locally (~15–80 ms). */
  startMs?: number;
  /** Lag at which every non-exempt request is shed. Default 1000 ms. */
  allMs?: number;
  /** Sent as `Retry-After`. Default 1 s. */
  retryAfterSeconds?: number;
  random?: () => number;
  /** Called once per shed request (metrics/logging); must not throw — it is guarded anyway. */
  onShed?: (req: Request) => void;
}

export function createLoadShedMiddleware(opts: LoadShedOptions) {
  const startMs = opts.startMs ?? 200;
  const allMs = opts.allMs ?? 1000;
  const retryAfter = String(Math.max(1, Math.round(opts.retryAfterSeconds ?? 1)));
  const random = opts.random ?? Math.random;

  return function loadShed(req: Request, res: Response, next: NextFunction): void {
    let p = 0;
    try {
      if (!isLoadShedExempt(req.path)) p = shedProbability(opts.lagMs(), startMs, allMs);
    } catch {
      p = 0; // a broken sampler must never take the site down
    }
    if (p > 0 && random() < p) {
      try { opts.onShed?.(req); } catch { /* observability must not break the response */ }
      res.setHeader("Retry-After", retryAfter);
      res.status(503).json({ error: "overloaded", message: "The server is busy. Please retry shortly.", retryAfterSeconds: Number(retryAfter) });
      return;
    }
    next();
  };
}

/**
 * Samples event-loop delay over a rolling window. `lagMs()` returns the 99th-percentile delay observed in the
 * last COMPLETED window (0 until the first window ends). p99 rather than the mean: an overloaded loop is a
 * heavy-tailed thing — a mean of 40 ms can hide a 900 ms stall that every request in flight just sat through.
 * The timer is unref'd so it never keeps the process alive.
 */
export function startEventLoopLagSampler(windowMs = 500): { lagMs: () => number; stop: () => void } {
  const hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  let last = 0;
  const timer = setInterval(() => {
    const ns = hist.percentile(99);
    last = Number.isFinite(ns) ? ns / 1e6 : 0;
    hist.reset();
  }, windowMs);
  timer.unref();
  return {
    lagMs: () => last,
    stop: () => {
      clearInterval(timer);
      hist.disable();
    },
  };
}

/** Env parsing that falls back to the default on anything that is not a positive finite number. */
export function positiveNumberFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}
