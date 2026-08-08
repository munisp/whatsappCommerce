/**
 * chatSession — unit tests
 * Redis-backed state machine (wa:sess:{tenantId}:{phone}, TTL 1800s) with the
 * dev/test in-memory fallback when Redis is unavailable (NODE_ENV=test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable Redis client mock — null means "Redis unavailable".
let redisClient: {
  get: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("./redis", () => ({
  getRedis: vi.fn(async () => redisClient),
}));

import {
  __clearMemorySessions,
  clearSession,
  getSession,
  newSession,
  saveSession,
  sessionKey,
  SESSION_TTL_SECONDS,
} from "./services/chatSession";

const T = "tenant-1";
const P = "+2348012345678";

beforeEach(() => {
  redisClient = null;
  __clearMemorySessions();
});

describe("Redis-backed sessions", () => {
  it("persists with key wa:sess:{tenantId}:{phone} and TTL 1800s", async () => {
    const store = new Map<string, string>();
    redisClient = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      setex: vi.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); }),
      del: vi.fn(async (k: string) => { store.delete(k); }),
    };
    const session = { ...newSession(T, P), mode: "usecase" as const, activeUseCase: "booking" as const, step: "choose_service" };
    await saveSession(session);
    expect(redisClient.setex).toHaveBeenCalledWith(sessionKey(T, P), SESSION_TTL_SECONDS, expect.any(String));
    expect(sessionKey(T, P)).toBe("wa:sess:tenant-1:+2348012345678");

    const loaded = await getSession(T, P);
    expect(loaded?.mode).toBe("usecase");
    expect(loaded?.activeUseCase).toBe("booking");
    expect(loaded?.step).toBe("choose_service");
  });

  it("clearSession deletes the Redis key", async () => {
    const store = new Map<string, string>();
    redisClient = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      setex: vi.fn(async (k: string, _t: number, v: string) => { store.set(k, v); }),
      del: vi.fn(async (k: string) => { store.delete(k); }),
    };
    await saveSession(newSession(T, P));
    await clearSession(T, P);
    expect(redisClient.del).toHaveBeenCalledWith(sessionKey(T, P));
    expect(await getSession(T, P)).toBeNull();
  });

  it("returns null for a missing or cross-tenant session", async () => {
    redisClient = {
      get: vi.fn(async () => JSON.stringify({ tenantId: "other", phone: P, mode: "menu" })),
      setex: vi.fn(),
      del: vi.fn(),
    };
    expect(await getSession(T, P)).toBeNull();
  });
});

describe("in-memory fallback (dev/test, Redis unavailable)", () => {
  it("saves and loads session state transitions", async () => {
    expect(await getSession(T, P)).toBeNull();
    await saveSession({ ...newSession(T, P), awaitingConsent: true });
    let s = await getSession(T, P);
    expect(s?.awaitingConsent).toBe(true);

    await saveSession({ ...s!, awaitingConsent: false, awaitingMenuSelection: true, mode: "menu" });
    s = await getSession(T, P);
    expect(s?.awaitingMenuSelection).toBe(true);

    await clearSession(T, P);
    expect(await getSession(T, P)).toBeNull();
  });

  it("expires entries after the TTL", async () => {
    await saveSession(newSession(T, P), 0); // expires immediately
    expect(await getSession(T, P)).toBeNull();
  });

  it("keeps sessions isolated per tenant + phone", async () => {
    await saveSession({ ...newSession(T, P), step: "a" });
    await saveSession({ ...newSession(T, "+2349000000000"), step: "b" });
    expect((await getSession(T, P))?.step).toBe("a");
    expect((await getSession(T, "+2349000000000"))?.step).toBe("b");
    expect(await getSession("other-tenant", P)).toBeNull();
  });
});
