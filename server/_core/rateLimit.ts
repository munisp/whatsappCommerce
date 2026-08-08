/**
 * server/_core/rateLimit.ts — Shared Redis-backed rate-limit counter.
 *
 * The previous helper (redis.redisIncrEx) silently returned 0 whenever the
 * Redis client was unreachable or unconfigured — a silent-pass that let
 * unlimited traffic through in production exactly when the limiter was blind.
 *
 * This module treats an unreachable/null Redis client as a FAILURE (throws
 * RateLimitUnavailableError) so callers can make an explicit policy decision:
 *   - production: fail CLOSED (503) — a rate limiter that cannot count must
 *     not silently allow unlimited traffic;
 *   - development/test: fail OPEN with a warning — local dev without Redis
 *     must not block requests.
 */
import { getRedis } from "../redis";

/** Raised when the rate-limit counter cannot be read/written at all. */
export class RateLimitUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RateLimitUnavailableError";
  }
}

/**
 * Atomically increment `key` and set its TTL on first increment.
 * Returns the new count. THROWS RateLimitUnavailableError when Redis is
 * unreachable or not configured — never silently returns 0.
 */
export async function redisIncrExStrict(key: string, ttlSeconds: number): Promise<number> {
  let redis;
  try {
    redis = await getRedis();
  } catch (err: any) {
    throw new RateLimitUnavailableError(`rate-limit counter unavailable: ${err?.message ?? err}`, { cause: err });
  }
  if (!redis) {
    throw new RateLimitUnavailableError("rate-limit counter unavailable: Redis client is not connected");
  }
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  } catch (err: any) {
    throw new RateLimitUnavailableError(`rate-limit counter command failed: ${err?.message ?? err}`, { cause: err });
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Request count within the current window (when the counter worked). */
  count: number;
  limit: number;
  /** Seconds the client should wait before retrying (429/503 responses). */
  retryAfter: number;
  /** True when Redis was unavailable and the fail-open policy was applied (dev only). */
  degraded: boolean;
  /** Set when the counter failed — the reason the decision was degraded/denied. */
  error?: string;
}

/**
 * Fixed-window rate-limit check with an explicit outage policy.
 *
 * @param key        counter key (already namespaced + windowed by the caller)
 * @param limit      max requests per window
 * @param windowSeconds window length in seconds (set as TTL on first hit)
 * @param failClosed when true (production), a Redis outage DENIES the request
 *                   (allowed=false, retryAfter=30 → caller responds 503);
 *                   when false (dev/test), a Redis outage allows the request
 *                   with degraded=true and a console warning.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  failClosed: boolean,
): Promise<RateLimitDecision> {
  try {
    const count = await redisIncrExStrict(key, windowSeconds);
    if (count > limit) {
      return { allowed: false, count, limit, retryAfter: windowSeconds, degraded: false };
    }
    return { allowed: true, count, limit, retryAfter: 0, degraded: false };
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    if (failClosed) {
      console.error("[rate-limit] Redis error — denying request (fail closed):", reason);
      return { allowed: false, count: limit + 1, limit, retryAfter: 30, degraded: false, error: reason };
    }
    console.warn("[rate-limit] Redis unavailable — allowing request (dev fail-open):", reason);
    return { allowed: true, count: 0, limit, retryAfter: 0, degraded: true, error: reason };
  }
}
