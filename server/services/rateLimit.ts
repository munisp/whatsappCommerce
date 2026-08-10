/**
 * server/services/rateLimit.ts — Edge token-bucket rate limiting (wave 10).
 *
 * Three independent buckets, keyed by client IP (+ tenant when known):
 *   - webhook  POST /api/webhooks/*, /integrations/:system/webhook
 *              generous (default 300/min/IP) — Meta/Paystack RETRY deliveries
 *              and a tight limit would cause delivery-loss loops.
 *   - auth     /api/auth/login, /api/auth/callback, /api/auth/local
 *              strict (default 10/min/IP) — credential-stuffing brake.
 *   - api      everything else under /api (default 600/min/IP).
 *
 * /health, /health/ready and /api/health/* are NEVER rate-limited — load
 * balancer and uptime probes must not be turned away.
 *
 * Storage: Redis (fixed-window counters via the existing shared client in
 * server/redis.ts — the same client wave-4 chat sessions use). When Redis is
 * absent or errors, the limiter falls back to an in-process bucket. That
 * fallback is SAFE FOR SINGLE-NODE deploys only — with multiple replicas each
 * node gets its own counters and the effective limit multiplies. Run Redis in
 * any multi-node deployment (documented in docs/PRODUCTION_CHECKLIST.md).
 *
 * Unlike server/_core/rateLimit.ts (fail-closed for the tRPC tenant limiter),
 * the EDGE limiter fails over to in-memory instead of denying: an edge limiter
 * outage must never take the public webhooks down.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getRedis } from "../redis";

export interface BucketHit {
  /** Requests seen in the current window (after this hit). */
  count: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  backend: "redis" | "memory";
}

export interface BucketBackend {
  hit(key: string, windowMs: number, now: number): Promise<BucketHit>;
}

/** In-process fixed-window bucket. Single-node safe; used as fallback/test. */
export class InMemoryBucketBackend implements BucketBackend {
  private windows = new Map<string, { count: number; resetAt: number }>();
  /** Bound the map so a hostile key spray cannot grow it forever. */
  constructor(private readonly maxKeys = 50_000) {}

  async hit(key: string, windowMs: number, now: number): Promise<BucketHit> {
    const existing = this.windows.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return { count: existing.count, resetAt: existing.resetAt, backend: "memory" };
    }
    if (!existing && this.windows.size >= this.maxKeys) this.evictExpired(now);
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const entry = { count: 1, resetAt: windowStart + windowMs };
    this.windows.set(key, entry);
    return { count: entry.count, resetAt: entry.resetAt, backend: "memory" };
  }

  private evictExpired(now: number): void {
    this.windows.forEach((v, k) => {
      if (v.resetAt <= now) this.windows.delete(k);
    });
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }

  /** Test helper. */
  size(): number {
    return this.windows.size;
  }
}

/**
 * Redis fixed-window bucket using the shared client from server/redis.ts.
 * Falls back to the provided in-memory backend when Redis is not configured,
 * not yet connected, or a command fails (logged once per failure burst).
 */
export class RedisBucketBackend implements BucketBackend {
  constructor(
    private readonly fallback: InMemoryBucketBackend,
    private readonly getClient: typeof getRedis = getRedis,
  ) {}

  async hit(key: string, windowMs: number, now: number): Promise<BucketHit> {
    try {
      const redis = await this.getClient();
      if (redis) {
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const redisKey = `rl:edge:${key}:${windowStart}`;
        const count = await redis.incr(redisKey);
        if (count === 1) await redis.pexpire(redisKey, windowMs);
        return { count, resetAt: windowStart + windowMs, backend: "redis" };
      }
    } catch (err: any) {
      console.warn("[rate-limit] Redis bucket failed — falling back to in-memory (single-node safe only):", err?.message ?? err);
    }
    return this.fallback.hit(key, windowMs, now);
  }
}

export type BucketKind = "webhook" | "auth" | "api";

export interface RateLimitResult {
  allowed: boolean;
  kind: BucketKind;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  backend: "redis" | "memory";
}

export interface RateLimiterOptions {
  backend: BucketBackend;
  now?: () => number;
  limits?: Partial<Record<BucketKind, { limit: number; windowMs: number }>>;
}

const MINUTE = 60_000;

export const DEFAULT_LIMITS: Record<BucketKind, { limit: number; windowMs: number }> = {
  webhook: { limit: intFromEnv("RATE_LIMIT_WEBHOOK_PER_MIN", 300), windowMs: MINUTE },
  auth: { limit: intFromEnv("RATE_LIMIT_AUTH_PER_MIN", 10), windowMs: MINUTE },
  api: { limit: intFromEnv("RATE_LIMIT_API_PER_MIN", 600), windowMs: MINUTE },
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Path-based bucket classification. Health probes are explicitly EXEMPT
 * (returned as null) — they must never be rate-limited.
 */
export function classifyRequest(method: string, path: string): BucketKind | null {
  if (path === "/health" || path === "/health/ready" || path.startsWith("/api/health")) return null;
  if (method === "POST" && path.startsWith("/api/webhooks/")) return "webhook";
  if (method === "POST" && /^\/integrations\/[^/]+\/webhook/.test(path)) return "webhook";
  if (path === "/api/auth/login" || path === "/api/auth/local" || path === "/api/auth/callback") return "auth";
  if (path.startsWith("/api/")) return "api";
  return null;
}

/** Client IP — trusts X-Forwarded-For only from the left-most hop (Caddy/ingress). */
export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

export class RateLimiter {
  private readonly now: () => number;
  private readonly limits: Record<BucketKind, { limit: number; windowMs: number }>;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.limits = {
      webhook: { ...DEFAULT_LIMITS.webhook, ...opts.limits?.webhook },
      auth: { ...DEFAULT_LIMITS.auth, ...opts.limits?.auth },
      api: { ...DEFAULT_LIMITS.api, ...opts.limits?.api },
    };
  }

  /** Consume one token. Buckets are fully independent (per-kind key prefix). */
  async check(kind: BucketKind, key: string): Promise<RateLimitResult> {
    const { limit, windowMs } = this.limits[kind];
    const hit = await this.opts.backend.hit(`${kind}:${key}`, windowMs, this.now());
    const allowed = hit.count <= limit;
    return {
      allowed,
      kind,
      limit,
      remaining: Math.max(0, limit - hit.count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((hit.resetAt - this.now()) / 1000)),
      backend: hit.backend,
    };
  }
}

export interface EdgeRateLimitOptions {
  limiter: RateLimiter;
  /** Extra key material (e.g. tenant id) when the request carries it. */
  tenantKey?: (req: Request) => string | undefined;
}

/** Express middleware factory — wire BEFORE route handlers. */
export function edgeRateLimitMiddleware(options: EdgeRateLimitOptions): RequestHandler {
  const { limiter, tenantKey } = options;
  return async (req: Request, res: Response, next: NextFunction) => {
    const kind = classifyRequest(req.method, req.path);
    if (!kind) return next(); // health probes and non-API traffic: never limited
    const tenant = tenantKey?.(req);
    const key = tenant ? `${clientIp(req)}:${tenant}` : clientIp(req);
    try {
      const result = await limiter.check(kind, key);
      res.setHeader("X-RateLimit-Limit", String(result.limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        res.status(429).json({
          error: "Too many requests",
          bucket: kind,
          retryAfter: result.retryAfterSeconds,
        });
        return;
      }
      next();
    } catch (err: any) {
      // The limiter itself must never take the edge down — fail open here.
      console.error("[rate-limit] edge limiter error — allowing request:", err?.message ?? err);
      next();
    }
  };
}

/**
 * Prebuilt limiter for server/_core/index.ts: Redis-backed with in-memory
 * fallback, tenant-aware via X-Tenant-Id header.
 */
export function createEdgeRateLimitMiddleware(): RequestHandler {
  const memory = new InMemoryBucketBackend();
  const backend = new RedisBucketBackend(memory);
  const limiter = new RateLimiter({ backend });
  return edgeRateLimitMiddleware({
    limiter,
    tenantKey: (req) => (req.headers["x-tenant-id"] as string | undefined) ?? undefined,
  });
}
