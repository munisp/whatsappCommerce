/**
 * server/redisOutage.test.ts — Redis outage behavior of the /api/trpc rate limiter.
 *
 * Pins the fix for the silent-pass finding: the old redisIncrEx returned 0
 * when Redis was unreachable, so the limiter silently allowed UNLIMITED
 * traffic exactly when it was blind. The new helper
 * (server/_core/rateLimit.ts) treats an unreachable/null Redis client as a
 * FAILURE: production fails CLOSED (503), dev/test fails OPEN with a warning.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable Redis client mock.
let redisClient: { incr: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn> } | null = null;

vi.mock("./redis", () => ({
  getRedis: vi.fn(async () => redisClient),
  redisSet: vi.fn(async () => {}),
  redisGet: vi.fn(async () => null),
  redisDel: vi.fn(async () => {}),
  redisIncrEx: vi.fn(async () => 0),
  redisHealthCheck: vi.fn(async () => ({ online: false, error: "mock" })),
  setConversationContext: vi.fn(async () => {}),
  getConversationContext: vi.fn(async () => null),
}));

const { redisIncrExStrict, checkRateLimit, RateLimitUnavailableError } = await import("./_core/rateLimit");

describe("redisIncrExStrict — unreachable Redis is a FAILURE, never count=0", () => {
  beforeEach(() => {
    redisClient = null;
  });

  it("throws RateLimitUnavailableError when the Redis client is null (not connected)", async () => {
    redisClient = null;
    await expect(redisIncrExStrict("rl:test:1", 60)).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it("never resolves to 0 on outage (the old silent-pass bug)", async () => {
    redisClient = null;
    const result = await redisIncrExStrict("rl:test:2", 60).catch((e) => e);
    expect(result).not.toBe(0);
    expect(result).toBeInstanceOf(RateLimitUnavailableError);
  });

  it("throws when the INCR command itself fails (connection dropped mid-window)", async () => {
    redisClient = {
      incr: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
      expire: vi.fn(),
    };
    await expect(redisIncrExStrict("rl:test:3", 60)).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it("returns the count and sets TTL only on the first increment when Redis works", async () => {
    const expire = vi.fn().mockResolvedValue(1);
    redisClient = { incr: vi.fn().mockResolvedValue(1), expire };
    await expect(redisIncrExStrict("rl:test:4", 60)).resolves.toBe(1);
    expect(expire).toHaveBeenCalledWith("rl:test:4", 60);

    redisClient = { incr: vi.fn().mockResolvedValue(2), expire };
    await expect(redisIncrExStrict("rl:test:4", 60)).resolves.toBe(2);
    expect(expire).toHaveBeenCalledTimes(1); // not called again for count > 1
  });
});

describe("checkRateLimit — outage policy", () => {
  beforeEach(() => {
    redisClient = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fail-closed (production): Redis outage DENIES with 503 semantics", async () => {
    const decision = await checkRateLimit("rl:trpc:tenant:1", 200, 60, true);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfter).toBe(30);
    expect(decision.error).toBeTruthy();
    expect(decision.degraded).toBe(false);
  });

  it("fail-open (dev/test): Redis outage ALLOWS with a warning (degraded)", async () => {
    const decision = await checkRateLimit("rl:trpc:tenant:2", 200, 60, false);
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.error).toBeTruthy();
    expect(console.warn).toHaveBeenCalled();
  });

  it("over-limit when Redis works: denies with 429 semantics", async () => {
    redisClient = { incr: vi.fn().mockResolvedValue(201), expire: vi.fn() };
    const decision = await checkRateLimit("rl:trpc:tenant:3", 200, 60, true);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfter).toBe(60);
    expect(decision.error).toBeUndefined();
    expect(decision.count).toBe(201);
  });

  it("under-limit when Redis works: allows", async () => {
    redisClient = { incr: vi.fn().mockResolvedValue(42), expire: vi.fn() };
    const decision = await checkRateLimit("rl:trpc:tenant:4", 200, 60, true);
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(false);
  });
});
