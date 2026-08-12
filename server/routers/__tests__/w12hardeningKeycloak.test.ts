/**
 * W12.1 hardening — keycloak SSO rebind lock + admin-only rebindSsoProfile.
 *
 * Proves:
 *  - a tenant SSO profile bound to one Keycloak subject can NOT be silently
 *    rebound by a different subject at exchangeCode time — even when the new
 *    token's email matches a tenant user (the W12 first-bind email check is
 *    not a rebind path);
 *  - rebindSsoProfile is admin-only, 404s when no profile exists, and on
 *    success rewrites ssoSub (returning previousSub) with an audit warning;
 *  - after an admin rebind, the NEW subject passes exchangeCode as a
 *    returning SSO user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { keycloakRouter } from "../keycloak";

const TENANT = "11111111-1111-4111-8111-111111111111";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "leftJoin", "offset", "set", "values", "onConflictDoUpdate", "onConflictDoNothing", "returning"]) {
    c[m] = () => c;
  }
  return c;
}

function makeDb(selectResponses: any[]) {
  let i = 0;
  const inserted: any[] = [];
  const updates: any[] = [];
  const db: any = {
    select: vi.fn(() => makeChain(selectResponses[i++] ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return makeChain([]);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
  };
  return { db, inserted, updates };
}

const configRow = {
  secretKey:
    "keycloak::" +
    JSON.stringify({
      serverUrl: "https://kc.example.com",
      realm: "r1",
      clientId: "c1",
      enableSso: true,
    }),
  webhookSecret: null,
};

function idToken(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `hdr.${body}.sig`;
}

function mockTokenEndpoint(payload: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "at", id_token: idToken(payload), expires_in: 3600 }),
    })),
  );
}

const PUBLIC_CTX = { user: null } as any;
const ADMIN_CTX = { user: { id: 1, role: "admin", tenantId: null } } as any;
const EXCHANGE_INPUT = {
  tenantId: TENANT,
  code: "authcode",
  redirectUri: "https://portal.example.com/callback",
};
const BOUND_PROFILE = { tenantId: TENANT, ssoSub: "kc-sub-owner", ssoEmail: "owner@tenant.example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("keycloak.exchangeCode rebind lock (W12.1)", () => {
  it("rejects a different sub even when its email matches a tenant user — admin must rebind", async () => {
    mockTokenEndpoint({ sub: "kc-sub-takeover", email: "owner@tenant.example.com" });
    const { db } = makeDb([
      [configRow],
      [BOUND_PROFILE], // profile already bound to kc-sub-owner
      [{ email: "owner@tenant.example.com", role: "admin" }], // tenant users
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.exchangeCode(EXCHANGE_INPUT)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("rebindSsoProfile"),
    });
  });

  it("does not rewrite the bound profile on a rejected rebind attempt", async () => {
    mockTokenEndpoint({ sub: "kc-sub-takeover", email: "owner@tenant.example.com" });
    const { db, inserted, updates } = makeDb([
      [configRow],
      [BOUND_PROFILE],
      [{ email: "owner@tenant.example.com", role: "admin" }],
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.exchangeCode(EXCHANGE_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe("keycloak.rebindSsoProfile admin gate", () => {
  const REBIND_INPUT = { tenantId: TENANT, ssoSub: "kc-sub-takeover" };

  it("rejects non-admin users", async () => {
    const caller = keycloakRouter.createCaller({ user: { id: 2, role: "user", tenantId: TENANT } } as any);
    await expect(caller.rebindSsoProfile(REBIND_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers", async () => {
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.rebindSsoProfile(REBIND_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("404s when the tenant has no SSO profile to rebind", async () => {
    const { db } = makeDb([[]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(ADMIN_CTX);
    await expect(caller.rebindSsoProfile(REBIND_INPUT)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rebinds as admin: updates ssoSub, returns previousSub, and writes an audit warning", async () => {
    const { db, updates } = makeDb([[BOUND_PROFILE]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = keycloakRouter.createCaller(ADMIN_CTX);
    const r = await caller.rebindSsoProfile(REBIND_INPUT);
    expect(r).toMatchObject({ ok: true, previousSub: "kc-sub-owner", ssoSub: "kc-sub-takeover" });
    expect(updates[0]).toMatchObject({ ssoSub: "kc-sub-takeover" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SSO REBIND"));
    warn.mockRestore();
  });

  it("after an admin rebind, the new subject passes exchangeCode as a returning SSO user", async () => {
    mockTokenEndpoint({ sub: "kc-sub-takeover", email: "new-owner@tenant.example.com" });
    const { db } = makeDb([
      [configRow],
      [{ ...BOUND_PROFILE, ssoSub: "kc-sub-takeover" }], // rebound profile
      [{ name: "Tenant Co" }], // tenant row for session payload
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    const r = await caller.exchangeCode(EXCHANGE_INPUT);
    expect(r.sessionToken).toBeTruthy();
    expect(r.tenantId).toBe(TENANT);
  });
});
