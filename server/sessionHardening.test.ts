/**
 * sessionHardening.test.ts — W12 session hardening tests.
 * TTL env override, jti issuance, expired/revoked token rejection,
 * logout revocation, admin revoke-all, fail-closed prod behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrpcContext } from "./_core/context";

// Structured condition mocks for the fake DB.
vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ __op: "eq" as const, col: col.name, val }),
    inArray: (col: { name: string }, vals: unknown[]) => ({ __op: "in" as const, col: col.name, vals }),
  };
});

type Revocation = { jti: string; userId: string | null; expiresAt: Date };
const revocations: Revocation[] = [];
const membershipsByUser = new Map<string, string[]>();

const { sessionRevocations, tenantMemberships } = await import("../drizzle/schema");

const fakeDb = {
  select: (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (cond: any) => {
        if (table === sessionRevocations && cond?.__op === "in") {
          return Promise.resolve(revocations.filter((r) => cond.vals.includes(r.jti)).map((r) => ({ jti: r.jti })));
        }
        if (table === tenantMemberships && cond?.__op === "eq" && cond.col === "userId") {
          return Promise.resolve((membershipsByUser.get(String(cond.val)) ?? []).map((t) => ({ tenantId: t })));
        }
        return Promise.resolve([]);
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: (v: Revocation) => ({
      onConflictDoNothing: async () => {
        if (table === sessionRevocations && !revocations.some((r) => r.jti === v.jti)) {
          revocations.push(v);
        }
      },
    }),
  }),
};

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: async () => fakeDb,
  getUserByOpenId: async (openId: string) => ({
    id: 7,
    openId,
    name: "Test User",
    email: "t@example.com",
    loginMethod: "local",
    role: "user",
    tenantId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  }),
  upsertUser: async () => {},
}));

const auth = await import("./_core/auth");
const sdkMod = await import("./_core/sdk");
const { appRouter } = await import("./routers");

const USER = {
  id: "7", openId: "user-7", email: "t@example.com", name: "Test User",
  role: "user" as const, tenantId: null, loginMethod: "local",
};

beforeEach(() => {
  revocations.length = 0;
  membershipsByUser.clear();
  sdkMod.clearSessionCaches();
});

afterEach(() => {
  delete process.env.SESSION_TTL;
});

function reqWithCookie(token: string) {
  return { headers: { cookie: `wa_session=${token}` } } as Parameters<typeof sdkMod.sdk.authenticateRequest>[0];
}

describe("session TTL", () => {
  it("defaults to 12h", () => {
    expect(auth.sessionTtl()).toBe("12h");
  });
  it("issues tokens expiring ~12h from now by default", () => {
    const payload = auth.verifySessionToken(auth.signSessionToken(USER));
    expect(payload?.exp && payload?.iat).toBeTruthy();
    const ttl = (payload!.exp! - payload!.iat!) / 3600;
    expect(ttl).toBeGreaterThan(11.9);
    expect(ttl).toBeLessThanOrEqual(12.01);
  });
  it("honors the SESSION_TTL env override", () => {
    process.env.SESSION_TTL = "30m";
    expect(auth.sessionTtl()).toBe("30m");
    const payload = auth.verifySessionToken(auth.signSessionToken(USER));
    expect(payload!.exp! - payload!.iat!).toBe(1800);
  });
  it("rejects expired tokens", () => {
    const token = auth.signSessionToken(USER, "0s");
    expect(auth.verifySessionToken(token)).toBeNull();
  });
});

describe("token jti issuance", () => {
  it("includes a unique jti and the uid claim", () => {
    const p1 = auth.verifySessionToken(auth.signSessionToken(USER));
    const p2 = auth.verifySessionToken(auth.signSessionToken(USER));
    expect(p1?.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(p1?.uid).toBe("7");
    expect(p1?.jti).not.toBe(p2?.jti);
  });
});

describe("session revocation (sdk)", () => {
  it("isSessionRevoked is false for unknown jtis", async () => {
    expect(await sdkMod.isSessionRevoked({ jti: "nope", userId: "7" })).toBe(false);
  });
  it("revokeSessionJti revokes the jti", async () => {
    await sdkMod.revokeSessionJti("jti-1", "7", new Date(Date.now() + 3600e3));
    expect(await sdkMod.isSessionRevoked({ jti: "jti-1" })).toBe(true);
    expect(await sdkMod.isSessionRevoked({ jti: "jti-2" })).toBe(false);
  });
  it("revokeAllUserSessions revokes via the user marker", async () => {
    await sdkMod.revokeAllUserSessions(7);
    expect(await sdkMod.isSessionRevoked({ userId: 7 })).toBe(true);
    expect(await sdkMod.isSessionRevoked({ userId: 8 })).toBe(false);
  });
  it("caches revocation results (second check does not hit the DB again)", async () => {
    await sdkMod.revokeSessionJti("jti-c", "7", new Date(Date.now() + 3600e3));
    expect(await sdkMod.isSessionRevoked({ jti: "jti-c" })).toBe(true);
    revocations.length = 0; // DB "lost" the row; cache should still say revoked
    expect(await sdkMod.isSessionRevoked({ jti: "jti-c" })).toBe(true);
  });
  it("authenticateRequest rejects a revoked wa_session token", async () => {
    const token = auth.signSessionToken(USER);
    const payload = auth.verifySessionToken(token)!;
    await sdkMod.revokeSessionJti(payload.jti!, payload.uid!, new Date(payload.exp! * 1000));
    await expect(sdkMod.sdk.authenticateRequest(reqWithCookie(token))).rejects.toThrow(/revoked/i);
  });
  it("authenticateRequest accepts a valid, unrevoked token and attaches memberships", async () => {
    membershipsByUser.set("7", ["t-alpha"]);
    const token = auth.signSessionToken(USER);
    const user = await sdkMod.sdk.authenticateRequest(reqWithCookie(token));
    expect(user.openId).toBe("user-7");
    expect(user.memberships).toEqual(["t-alpha"]);
  });
});

describe("auth.logout + auth.revokeUserSessions (router)", () => {
  function ctx(user: Record<string, unknown> | null, cookie?: string) {
    const cleared: string[] = [];
    const ctxObj: TrpcContext = {
      user: user as TrpcContext["user"],
      req: { protocol: "https", headers: cookie ? { cookie } : {} } as TrpcContext["req"],
      res: { clearCookie: (n: string) => cleared.push(n) } as unknown as TrpcContext["res"],
      resolvedTenantId: "default",
    };
    return { ctxObj, cleared };
  }

  it("logout revokes the current token's jti and clears the cookie", async () => {
    const token = auth.signSessionToken(USER);
    const payload = auth.verifySessionToken(token)!;
    const { ctxObj, cleared } = ctx({ id: 7, role: "user" }, `wa_session=${token}`);
    const result = await appRouter.createCaller(ctxObj).auth.logout();
    expect(result).toEqual({ success: true });
    expect(cleared).toHaveLength(1);
    expect(revocations.some((r) => r.jti === payload.jti)).toBe(true);
    expect(await sdkMod.isSessionRevoked({ jti: payload.jti })).toBe(true);
  });
  it("logout still succeeds without a session cookie", async () => {
    const { ctxObj, cleared } = ctx({ id: 7, role: "user" });
    await expect(appRouter.createCaller(ctxObj).auth.logout()).resolves.toEqual({ success: true });
    expect(cleared).toHaveLength(1);
    expect(revocations).toHaveLength(0);
  });
  it("revokeUserSessions is admin-only and writes the user marker", async () => {
    const { ctxObj } = ctx({ id: 1, role: "admin" });
    await expect(
      appRouter.createCaller(ctxObj).auth.revokeUserSessions({ userId: "7" }),
    ).resolves.toEqual({ success: true });
    expect(revocations.some((r) => r.jti === sdkMod.userRevocationMarkerJti("7"))).toBe(true);
    expect(await sdkMod.isSessionRevoked({ userId: "7" })).toBe(true);
  });
  it("revokeUserSessions rejects non-admin callers", async () => {
    const { ctxObj } = ctx({ id: 7, role: "user" });
    await expect(
      appRouter.createCaller(ctxObj).auth.revokeUserSessions({ userId: "7" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(revocations).toHaveLength(0);
  });
});
