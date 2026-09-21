/**
 * QA-039 (server half): PKCE for the tenant-portal Keycloak SSO.
 *
 * The server is not where the login-CSRF check happens (only the browser remembers the state — see
 * client/src/lib/ssoTransaction.ts). Its job is narrower and is what these pin: put the S256 challenge on the
 * authorization URL, forward the verifier in the token request — that forwarding is what makes Keycloak refuse a code
 * issued for a different browser — and refuse anything that is not shaped like a challenge/verifier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { keycloakRouter } from "../keycloak";

const TENANT = "11111111-1111-4111-8111-111111111111";

function makeChain(rows: any) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "leftJoin", "offset", "set", "values", "onConflictDoUpdate", "onConflictDoNothing", "returning"]) c[m] = () => c;
  return c;
}
function makeDb(selectResponses: any[]) {
  let i = 0;
  return { select: vi.fn(() => makeChain(selectResponses[i++] ?? [])), insert: vi.fn(() => ({ values: vi.fn(() => makeChain([])) })) } as any;
}

const configRow = {
  secretKey: "keycloak::" + JSON.stringify({ serverUrl: "https://kc.example.com", realm: "r1", clientId: "c1", enableSso: true }),
  webhookSecret: null,
};
const idToken = (payload: Record<string, unknown>) => `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

// 43 chars of base64url — what a real S256 challenge looks like
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
// 64 chars, RFC 7636 unreserved set
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-._~abcdefghijklmnop";

const asUser = () => keycloakRouter.createCaller({ user: { id: 2, role: "user", tenantId: TENANT } } as any);
const asPublic = () => keycloakRouter.createCaller({ user: null } as any);

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("keycloak.getLoginUrl", () => {
  const input = { tenantId: TENANT, redirectUri: "https://app.example.com/portal/sso-callback", state: "st" };

  it("puts the S256 challenge on the authorization URL when the browser supplies one", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[configRow]]));
    const { authUrl } = await asUser().getLoginUrl({ ...input, codeChallenge: CHALLENGE });
    const q = new URL(authUrl).searchParams;
    expect(q.get("code_challenge")).toBe(CHALLENGE);
    expect(q.get("code_challenge_method")).toBe("S256"); // never "plain" — plain would put the secret itself on the URL
    expect(q.get("state")).toBe("st");
  });

  it("sends no PKCE parameters when none was supplied (old callers keep working)", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[configRow]]));
    const { authUrl } = await asUser().getLoginUrl(input);
    const q = new URL(authUrl).searchParams;
    expect(q.has("code_challenge")).toBe(false);
    expect(q.has("code_challenge_method")).toBe(false);
  });

  it.each([
    ["too short", "abc"],
    ["42 chars", CHALLENGE.slice(0, 42)],
    ["44 chars", CHALLENGE + "A"],
    ["padding", CHALLENGE.slice(0, 42) + "="],
    ["standard-base64 '+'", CHALLENGE.slice(0, 42) + "+"],
    ["injection attempt", CHALLENGE.slice(0, 20) + "&state=evil&x=" + CHALLENGE.slice(0, 9)],
  ])("refuses something that is not an S256 challenge (%s) before it reaches the URL", async (_n, bad) => {
    vi.mocked(getDb).mockResolvedValue(makeDb([[configRow]]));
    await expect(asUser().getLoginUrl({ ...input, codeChallenge: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("keycloak.exchangeCode", () => {
  const input = { tenantId: TENANT, code: "authcode", redirectUri: "https://app.example.com/portal/sso-callback" };

  function captureTokenRequest() {
    const seen: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return { ok: true, json: async () => ({ access_token: "at", id_token: idToken({ sub: "kc-sub-owner", email: "owner@tenant.example.com" }), expires_in: 3600 }) };
    }));
    return seen;
  }
  const dbForSuccess = () => makeDb([[configRow], [{ tenantId: TENANT, ssoSub: "kc-sub-owner", ssoEmail: "owner@tenant.example.com" }], [{ name: "Tenant Co" }]]);

  it("forwards the PKCE verifier to Keycloak's token endpoint", async () => {
    const seen = captureTokenRequest();
    vi.mocked(getDb).mockResolvedValue(dbForSuccess());
    await asPublic().exchangeCode({ ...input, codeVerifier: VERIFIER });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://kc.example.com/realms/r1/protocol/openid-connect/token");
    expect(seen[0].body.get("code_verifier")).toBe(VERIFIER);
    expect(seen[0].body.get("code")).toBe("authcode");
    expect(seen[0].body.get("grant_type")).toBe("authorization_code");
  });

  it("sends no code_verifier when none was supplied (old callers keep working)", async () => {
    const seen = captureTokenRequest();
    vi.mocked(getDb).mockResolvedValue(dbForSuccess());
    await asPublic().exchangeCode(input);
    expect(seen[0].body.has("code_verifier")).toBe(false);
  });

  it.each([
    ["too short", "a".repeat(42)],
    ["too long", "a".repeat(129)],
    ["a character outside the unreserved set", "a".repeat(42) + "+"],
    ["a space", "a".repeat(20) + " " + "a".repeat(30)],
  ])("refuses a malformed verifier (%s) and never calls Keycloak", async (_n, bad) => {
    const seen = captureTokenRequest();
    vi.mocked(getDb).mockResolvedValue(dbForSuccess());
    await expect(asPublic().exchangeCode({ ...input, codeVerifier: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(seen).toHaveLength(0);
  });

  it("caps the size of code and state so a public endpoint is not a place to park megabytes", async () => {
    captureTokenRequest();
    vi.mocked(getDb).mockResolvedValue(dbForSuccess());
    await expect(asPublic().exchangeCode({ ...input, code: "x".repeat(2049) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(asPublic().exchangeCode({ ...input, state: "x".repeat(2049) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
