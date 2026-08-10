/**
 * Tests for the wave-10 edge rate limiter (server/services/rateLimit.ts):
 * bucket math, Redis-down fallback, bucket independence, health exemptions,
 * and middleware 429/Retry-After behavior. No real Redis needed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyRequest,
  clientIp,
  createEdgeRateLimitMiddleware,
  DEFAULT_LIMITS,
  edgeRateLimitMiddleware,
  InMemoryBucketBackend,
  RateLimiter,
  RedisBucketBackend,
} from "./rateLimit";

function makeLimiter(overrides?: Partial<ConstructorParameters<typeof RateLimiter>[0]>) {
  const memory = new InMemoryBucketBackend();
  const limiter = new RateLimiter({
    backend: memory,
    now: overrides?.now ?? (() => 1_000_000),
    limits: {
      webhook: { limit: 3, windowMs: 60_000 },
      auth: { limit: 2, windowMs: 60_000 },
      api: { limit: 4, windowMs: 60_000 },
      ...overrides?.limits,
    },
  });
  return { limiter, memory };
}

describe("RateLimiter bucket math", () => {
  it("allows requests up to the limit and reports remaining", async () => {
    const { limiter } = makeLimiter();
    const r1 = await limiter.check("api", "ip1");
    expect(r1).toMatchObject({ allowed: true, remaining: 3, limit: 4, retryAfterSeconds: 0 });
    const r2 = await limiter.check("api", "ip1");
    expect(r2.remaining).toBe(2);
  });

  it("denies the request after the limit with a positive Retry-After", async () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 2; i++) await limiter.check("auth", "ip1");
    const denied = await limiter.check("auth", "ip1");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("resets the bucket when the window rolls over", async () => {
    let now = 1_000_000;
    const { limiter } = makeLimiter({ now: () => now });
    for (let i = 0; i < 2; i++) await limiter.check("auth", "ip1");
    expect((await limiter.check("auth", "ip1")).allowed).toBe(false);
    now += 60_000; // next window
    expect((await limiter.check("auth", "ip1")).allowed).toBe(true);
  });

  it("tracks different keys (IPs) independently", async () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 2; i++) await limiter.check("auth", "ip1");
    expect((await limiter.check("auth", "ip1")).allowed).toBe(false);
    expect((await limiter.check("auth", "ip2")).allowed).toBe(true);
  });

  it("keeps webhook and auth buckets independent for the same key", async () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 2; i++) await limiter.check("auth", "ip1");
    expect((await limiter.check("auth", "ip1")).allowed).toBe(false);
    // webhook bucket untouched — Meta retries from the same IP still flow.
    expect((await limiter.check("webhook", "ip1")).allowed).toBe(true);
  });

  it("webhook limit is generous and auth limit is strict by default", () => {
    expect(DEFAULT_LIMITS.webhook.limit).toBeGreaterThanOrEqual(300);
    expect(DEFAULT_LIMITS.auth.limit).toBeLessThanOrEqual(10);
  });
});

describe("RedisBucketBackend fallback", () => {
  it("uses Redis when the client is available", async () => {
    const memory = new InMemoryBucketBackend();
    const incr = vi.fn().mockResolvedValue(1);
    const pexpire = vi.fn().mockResolvedValue(1);
    const backend = new RedisBucketBackend(memory, async () => ({ incr, pexpire } as any));
    const hit = await backend.hit("api:ip1", 60_000, 1_000_000);
    expect(hit).toMatchObject({ count: 1, backend: "redis" });
    expect(incr).toHaveBeenCalledOnce();
    expect(pexpire).toHaveBeenCalledOnce(); // TTL set on first increment
    expect(memory.size()).toBe(0); // in-memory fallback untouched
  });

  it("still limits via in-memory fallback when Redis is down (command throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = new InMemoryBucketBackend();
    const backend = new RedisBucketBackend(memory, async () => {
      throw new Error("redis connection refused");
    });
    const limiter = new RateLimiter({
      backend,
      now: () => 1_000_000,
      limits: { api: { limit: 2, windowMs: 60_000 } },
    });
    expect((await limiter.check("api", "ip1")).backend).toBe("memory");
    await limiter.check("api", "ip1");
    const denied = await limiter.check("api", "ip1");
    expect(denied.allowed).toBe(false); // fallback still enforces the limit
    warn.mockRestore();
  });

  it("falls back to memory when Redis is not configured (null client)", async () => {
    const memory = new InMemoryBucketBackend();
    const backend = new RedisBucketBackend(memory, async () => null);
    const hit = await backend.hit("auth:ip1", 60_000, 1_000_000);
    expect(hit.backend).toBe("memory");
    expect(memory.size()).toBe(1);
  });
});

describe("classifyRequest — health is never rate-limited", () => {
  it.each(["/health", "/health/ready", "/api/health/postgres", "/api/health/redis"])(
    "exempts %s",
    (path) => {
      expect(classifyRequest("GET", path)).toBeNull();
    },
  );

  it("classifies webhook POSTs into the webhook bucket", () => {
    expect(classifyRequest("POST", "/api/webhooks/whatsapp")).toBe("webhook");
    expect(classifyRequest("POST", "/api/webhooks/paystack")).toBe("webhook");
    expect(classifyRequest("POST", "/integrations/medusa/webhook")).toBe("webhook");
  });

  it("classifies auth endpoints into the strict auth bucket", () => {
    expect(classifyRequest("GET", "/api/auth/login")).toBe("auth");
    expect(classifyRequest("POST", "/api/auth/local")).toBe("auth");
    expect(classifyRequest("GET", "/api/auth/callback")).toBe("auth");
  });

  it("classifies other /api traffic into the general bucket and ignores non-api paths", () => {
    expect(classifyRequest("GET", "/api/trpc/products.list")).toBe("api");
    expect(classifyRequest("GET", "/api/webhooks/whatsapp")).toBe("api"); // Meta verify GET
    expect(classifyRequest("GET", "/assets/logo.png")).toBeNull();
  });
});

describe("edgeRateLimitMiddleware", () => {
  function mockRes() {
    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      body: undefined as any,
      setHeader: (k: string, v: string) => (headers[k] = v),
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: any) {
        res.body = payload;
        return res;
      },
    };
    return { res, headers };
  }

  it("returns 429 with Retry-After once the bucket is exhausted", async () => {
    const { limiter } = makeLimiter();
    const mw = edgeRateLimitMiddleware({ limiter });
    const req: any = { method: "POST", path: "/api/auth/local", headers: {}, socket: { remoteAddress: "1.2.3.4" } };
    const next = vi.fn();
    // auth limit = 2 in makeLimiter
    await mw(req, mockRes().res, next);
    await mw(req, mockRes().res, next);
    expect(next).toHaveBeenCalledTimes(2);
    const { res, headers } = mockRes();
    await mw(req, res, next);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error: "Too many requests", bucket: "auth" });
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(next).toHaveBeenCalledTimes(2); // third request NOT forwarded
  });

  it("never touches the limiter for health probes", async () => {
    const { limiter, memory } = makeLimiter();
    const mw = edgeRateLimitMiddleware({ limiter });
    const req: any = { method: "GET", path: "/health/ready", headers: {}, socket: { remoteAddress: "1.2.3.4" } };
    const next = vi.fn();
    await mw(req, mockRes().res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(memory.size()).toBe(0);
  });

  it("keys by tenant when X-Tenant-Id is present (tenants on one IP are independent)", async () => {
    const { limiter } = makeLimiter();
    const mw = edgeRateLimitMiddleware({
      limiter,
      tenantKey: (req) => req.headers["x-tenant-id"] as string | undefined,
    });
    const next = vi.fn();
    const baseReq = { method: "POST", path: "/api/auth/local", socket: { remoteAddress: "1.2.3.4" } };
    await mw({ ...baseReq, headers: { "x-tenant-id": "t1" } } as any, mockRes().res, next);
    await mw({ ...baseReq, headers: { "x-tenant-id": "t1" } } as any, mockRes().res, next);
    // t1 exhausted (limit 2)…
    const blocked = mockRes();
    await mw({ ...baseReq, headers: { "x-tenant-id": "t1" } } as any, blocked.res, next);
    expect(blocked.res.statusCode).toBe(429);
    // …but t2 from the same IP still has a fresh bucket.
    const allowed = mockRes();
    await mw({ ...baseReq, headers: { "x-tenant-id": "t2" } } as any, allowed.res, next);
    expect(allowed.res.statusCode).toBe(200);
  });

  it("createEdgeRateLimitMiddleware builds a working middleware (memory fallback, no Redis)", async () => {
    const mw = createEdgeRateLimitMiddleware();
    const req: any = { method: "GET", path: "/api/trpc/x", headers: { "x-forwarded-for": "9.9.9.9" }, socket: {} };
    const next = vi.fn();
    await mw(req, mockRes().res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("clientIp", () => {
  it("prefers the left-most X-Forwarded-For entry", () => {
    const req: any = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, ip: "3.3.3.3" };
    expect(clientIp(req)).toBe("1.1.1.1");
  });

  it("falls back to req.ip / socket address", () => {
    expect(clientIp({ headers: {}, ip: "3.3.3.3" } as any)).toBe("3.3.3.3");
    expect(clientIp({ headers: {}, socket: { remoteAddress: "4.4.4.4" } } as any)).toBe("4.4.4.4");
  });
});
