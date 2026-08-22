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

describe("saveSessionCas (optimistic concurrency)", () => {
  it("in-memory: CAS succeeds on matching version, fails on stale version", async () => {
    const { saveSessionCas } = await import("./services/chatSession");
    await saveSession({ ...newSession(T, P), step: "start" });
    const s1 = (await getSession(T, P))!;
    expect(s1.casVersion).toBe(1);

    // Two readers base mutations on version 1 — only the first wins.
    expect(await saveSessionCas({ ...s1, step: "writer-a" }, s1.casVersion!)).toBe(true);
    expect(await saveSessionCas({ ...s1, step: "writer-b" }, s1.casVersion!)).toBe(false);

    const after = (await getSession(T, P))!;
    expect(after.step).toBe("writer-a");
    expect(after.casVersion).toBe(2);

    // Reload-and-reapply recovers: writer B re-reads (v2) and CAS succeeds.
    expect(await saveSessionCas({ ...after, step: "writer-b" }, after.casVersion!)).toBe(true);
    expect((await getSession(T, P))?.step).toBe("writer-b");
  });

  it("in-memory: CAS fails when the session no longer exists", async () => {
    const { saveSessionCas } = await import("./services/chatSession");
    expect(await saveSessionCas(newSession(T, P), 0)).toBe(false);
  });

  it("redis: uses an atomic eval check-and-set", async () => {
    const { saveSessionCas } = await import("./services/chatSession");
    const store = new Map<string, string>();
    redisClient = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      setex: vi.fn(async (k: string, _t: number, v: string) => { store.set(k, v); }),
      del: vi.fn(async (k: string) => { store.delete(k); }),
      // Minimal eval shim honoring the Lua check-and-set contract.
      eval: vi.fn(async (_lua: string, _nk: number, k: string, expected: string, ttl: string, v: string) => {
        const cur = store.get(k);
        if (!cur) return 0;
        if ((JSON.parse(cur).casVersion ?? 0) !== Number(expected)) return 0;
        store.set(k, v);
        return 1;
      }),
    } as any;
    await saveSession(newSession(T, P));
    const s = (await getSession(T, P))!;
    expect(await saveSessionCas({ ...s, step: "x" }, s.casVersion!)).toBe(true);
    expect(await saveSessionCas({ ...s, step: "y" }, s.casVersion!)).toBe(false);
    expect((redisClient as any).eval).toHaveBeenCalled();
  });
});
