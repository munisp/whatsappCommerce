/**
 * W12 authz — keycloak.exchangeCode identity↔tenant binding + listSsoProfiles.
 *
 * Proves:
 *  - a valid Keycloak token can no longer mint a portal session for an
 *    arbitrary input.tenantId (session forgery → 403);
 *  - first-bind only succeeds when the realm user's email matches a user
 *    registered under that tenant;
 *  - a profile already bound to the same sub keeps working (returning SSO user);
 *  - listSsoProfiles is admin-only.
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
  const db: any = {
    select: vi.fn(() => makeChain(selectResponses[i++] ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return makeChain([]);
      }),
    })),
  };
  return { db, inserted };
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
const EXCHANGE_INPUT = {
  tenantId: TENANT,
  code: "authcode",
  redirectUri: "https://portal.example.com/callback",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("keycloak.exchangeCode identity-tenant binding", () => {
  it("rejects session forgery: valid token, no bound profile, email belongs to another tenant", async () => {
    mockTokenEndpoint({ sub: "kc-sub-attacker", email: "attacker@other.example.com" });
    const { db } = makeDb([
      [configRow], // keycloak config
      [], // no sso profile for tenant
      [{ email: "owner@tenant.example.com", role: "admin" }], // tenant users
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.exchangeCode(EXCHANGE_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects when profile exists but is bound to a different sub and email does not match", async () => {
    mockTokenEndpoint({ sub: "kc-sub-new", email: "stranger@example.com" });
    const { db } = makeDb([
      [configRow],
      [{ tenantId: TENANT, ssoSub: "kc-sub-owner", ssoEmail: "owner@tenant.example.com" }],
      [{ email: "owner@tenant.example.com", role: "admin" }],
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.exchangeCode(EXCHANGE_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects first-bind when the token carries no email", async () => {
    mockTokenEndpoint({ sub: "kc-sub-noemail" });
    const { db } = makeDb([[configRow], []]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.exchangeCode(EXCHANGE_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows first-bind when realm email matches the tenant owner's registered email", async () => {
    mockTokenEndpoint({ sub: "kc-sub-owner", email: "Owner@Tenant.example.com", name: "Owner" });
    const { db, inserted } = makeDb([
      [configRow],
      [], // no profile yet
      [{ email: "owner@tenant.example.com", role: "admin" }], // tenant users
      [{ name: "Tenant Co" }], // tenant row
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    const r = await caller.exchangeCode(EXCHANGE_INPUT);
    expect(r.sessionToken).toBeTruthy();
    expect(r.tenantId).toBe(TENANT);
    expect(inserted[0]?.ssoSub).toBe("kc-sub-owner");
  });

  it("allows a returning SSO user whose profile sub is already bound to the tenant", async () => {
    mockTokenEndpoint({ sub: "kc-sub-owner", email: "changed@example.com" });
    const { db } = makeDb([
      [configRow],
      [{ tenantId: TENANT, ssoSub: "kc-sub-owner", ssoEmail: "owner@tenant.example.com" }],
      [{ name: "Tenant Co" }],
    ]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    const r = await caller.exchangeCode(EXCHANGE_INPUT);
    expect(r.sessionToken).toBeTruthy();
  });
});

describe("keycloak.listSsoProfiles admin gate", () => {
  it("rejects non-admin users", async () => {
    const caller = keycloakRouter.createCaller({ user: { id: 2, role: "user", tenantId: TENANT } } as any);
    await expect(caller.listSsoProfiles({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers", async () => {
    const caller = keycloakRouter.createCaller(PUBLIC_CTX);
    await expect(caller.listSsoProfiles({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows platform admins", async () => {
    const { db } = makeDb([[]]);
    vi.mocked(getDb).mockResolvedValue(db);
    const caller = keycloakRouter.createCaller({ user: { id: 1, role: "admin", tenantId: null } } as any);
    const r = await caller.listSsoProfiles({ limit: 10, offset: 0 });
    expect(r.profiles).toEqual([]);
  });
});
