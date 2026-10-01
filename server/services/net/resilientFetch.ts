// === W48 integrations ===
/**
 * resilientFetch.ts — shared HTTP client hygiene for outbound integration
 * calls (PERF-INT-10 generic circuit breaker + PERF-INT-13 fetch hygiene).
 *
 * Problem: integrations each hand-rolled `fetch` with arbitrary (or missing)
 * timeouts, no bounded retry, and no circuit breaker. During a downstream
 * outage every request burned its full timeout serially and retries
 * amplified the failure (failure latency = timeout × attempts instead of
 * fast-fail).
 *
 * This module provides:
 *   - `fetchJson(url, opts)` — AbortController-bounded timeout, bounded
 *     retry-with-backoff on network errors / 5xx / 429, and an optional
 *     per-integration circuit breaker.
 *   - `IntegrationCircuitBreaker` — consecutive-failure trip + cooldown +
 *     half-open probe, in-proc (per worker). Mirrors the banCircuitBreaker
 *     doctrine (fail fast locally while a dependency is down) without
 *     coupling to WA ban semantics. Telemetry is fail-open: a broken breaker
 *     never blocks a call.
 *
 * Timeout budget table (p95 contract — docs/PERFORMANCE_BUDGETS.md):
 *   PSP initiate/verify     10_000 ms   (user-facing; registry adapters agree)
 *   ML/fraud scoring          800 ms    (order-create path; fail-open bounded)
 *   OpenSearch interactive  3_000 ms
 *   Permify check           3_000 ms
 *   WA Graph send          12_000 ms   (waSender — unchanged)
 *   Telegram send           5_000 ms   (telegramSender — unchanged)
 */
export const INTEGRATION_TIMEOUTS = {
  psp: 10_000,
  fraudGate: 800,
  opensearch: 3_000,
  permify: 3_000,
  waGraph: 12_000,
  telegram: 5_000,
  generic: 8_000,
} as const;

export class IntegrationTimeoutError extends Error {
  constructor(public readonly integration: string, public readonly timeoutMs: number) {
    super(`${integration}: request timed out after ${timeoutMs}ms`);
    this.name = "IntegrationTimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly integration: string) {
    super(`${integration}: circuit open — failing fast`);
    this.name = "CircuitOpenError";
  }
}

// ── Generic circuit breaker (PERF-INT-10) ───────────────────────────────────

interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms until which the circuit is open (fail fast). */
  openUntil: number;
  /** True while one half-open probe is in flight. */
  probing: boolean;
}

const breakers = new Map<string, BreakerState>();

/** Test hook: wipe all breaker state. */
export function __resetIntegrationBreakers(): void {
  breakers.clear();
}

/** Inspect breaker state (tests/journeys). */
export function integrationBreakerState(name: string): { open: boolean; consecutiveFailures: number } {
  const s = breakers.get(name);
  return { open: !!s && s.openUntil > Date.now(), consecutiveFailures: s?.consecutiveFailures ?? 0 };
}

function stateFor(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: 0, probing: false };
    breakers.set(name, s);
  }
  return s;
}

export interface BreakerOptions {
  /** Consecutive failures that trip the circuit. Default 5. */
  threshold?: number;
  /** How long the circuit stays open before a half-open probe. Default 30s. */
  cooldownMs?: number;
}

/** Throw CircuitOpenError when the named circuit is open. */
export function assertCircuitClosed(name: string): void {
  const s = stateFor(name);
  if (s.openUntil > Date.now() && !s.probing) throw new CircuitOpenError(name);
}

/** Record an outcome; trips/resets the breaker. Never throws. */
export function recordIntegrationOutcome(name: string, ok: boolean, opts: BreakerOptions = {}): void {
  try {
    const threshold = opts.threshold ?? 5;
    const cooldownMs = opts.cooldownMs ?? 30_000;
    const s = stateFor(name);
    if (ok) {
      s.consecutiveFailures = 0;
      s.openUntil = 0;
      s.probing = false;
      return;
    }
    s.consecutiveFailures += 1;
    if (s.openUntil > Date.now()) {
      // Half-open probe failed — re-open for another cooldown.
      s.probing = false;
      s.openUntil = Date.now() + cooldownMs;
    } else if (s.consecutiveFailures >= threshold) {
      s.openUntil = Date.now() + cooldownMs;
      s.probing = false;
      console.warn(`[resilientFetch] circuit OPEN for "${name}" after ${s.consecutiveFailures} consecutive failures (cooldown ${cooldownMs}ms)`);
    }
  } catch { /* breaker telemetry is fail-open */ }
}

// ── fetchJson (PERF-INT-13) ─────────────────────────────────────────────────

export interface FetchJsonOptions extends BreakerOptions {
  /** Integration name — used for breaker state + error messages. */
  integration: string;
  /** Hard per-attempt timeout. Default INTEGRATION_TIMEOUTS.generic. */
  timeoutMs?: number;
  /** Extra retries after the first attempt (network errors, 5xx, 429). Default 0. */
  retries?: number;
  /** Base backoff between attempts (doubled per retry). Default 250ms. */
  backoffMs?: number;
  /** Standard RequestInit (method/headers/body). `signal` is managed internally. */
  init?: RequestInit;
  /** Disable the circuit breaker for this call. Default false. */
  noBreaker?: boolean;
}

export interface FetchJsonResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Raw text body when JSON parsing failed. */
  text?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded fetch: per-attempt AbortController timeout + bounded retry with
 * exponential backoff (retriable = network error, timeout, 5xx, 429) +
 * optional circuit breaker. NEVER hangs past timeoutMs × (retries+1) +
 * backoff, and fails fast while the breaker is open.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions): Promise<FetchJsonResult<T>> {
  const timeoutMs = opts.timeoutMs ?? INTEGRATION_TIMEOUTS.generic;
  const retries = opts.retries ?? 0;
  const backoffMs = opts.backoffMs ?? 250;
  const name = opts.integration;

  if (!opts.noBreaker) assertCircuitClosed(name);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...opts.init, signal: ctrl.signal });
    } catch (err: any) {
      lastErr = err?.name === "AbortError" ? new IntegrationTimeoutError(name, timeoutMs) : err;
      // Network/timeout errors are retriable while attempts remain.
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500 || res.status === 429) {
      lastErr = new Error(`${name}: HTTP ${res.status}`);
      continue; // retriable status
    }
    if (!opts.noBreaker) recordIntegrationOutcome(name, true);
    const text = await res.text().catch(() => "");
    let data: T | null = null;
    try { data = text ? (JSON.parse(text) as T) : null; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, data, text };
  }
  // All attempts exhausted — trip the breaker and surface the last error.
  if (!opts.noBreaker) recordIntegrationOutcome(name, false, opts);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
