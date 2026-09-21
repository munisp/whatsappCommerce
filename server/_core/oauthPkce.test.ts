/**
 * QA follow-up: PKCE (RFC 7636) + OIDC nonce verification on the Keycloak
 * authorization_code flow (server/_core/oauth.ts, auth.ts).
 *
 * Runs the REAL express routes over a real socket. Two properties matter most
 * and are proven here rather than assumed:
 *
 *  1. The verifier sent at token exchange is the one whose S256 hash was sent
 *     as the code_challenge at login — and it travels in a signed cookie, not
 *     per-process memory, so a login started on one replica completes on
 *     another (a second, freshly-built app instance below stands in for that).
 *     Keycloak REQUIRES the verifier once a challenge was sent; an in-memory
 *     store would have turned every cross-replica login into a hard failure.
 *  2. The OIDC nonce sent at login is actually checked against the ID token.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

vi.mock("../db", () => ({
  getUserByOpenId: vi.fn(async () => ({ id: 7, role: "user", tenantId: null })),
  upsertUser: vi.fn(async () => undefined),
}));
vi.mock("../services/email/resend", () => ({ sendWelcomeEmail: vi.fn(async () => undefined) }));
vi.mock("./auth", async (orig) => ({
  ...(await orig<typeof import("./auth")>()),
  exchangeKeycloakCode: vi.fn(),
}));

import { registerOAuthRoutes } from "./oauth";
import { exchangeKeycloakCode, signOAuthTx, OAUTH_TX_COOKIE } from "./auth";

function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

function startApp(): Promise<{ base: string; server: Server }> {
  const app = express();
  registerOAuthRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () =>
      resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    );
  });
}

/** Perform GET /api/auth/login and return what a browser would carry forward. */
async function login(base: string) {
  const res = await fetch(`${base}/api/auth/login?redirect=/dash`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!, "http://kc.example");
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_TX_COOKIE}=`))!;
  return {
    setCookie,
    cookieHeader: setCookie.split(";")[0],
    state: loc.searchParams.get("state")!,
    nonce: loc.searchParams.get("nonce")!,
    challenge: loc.searchParams.get("code_challenge"),
    method: loc.searchParams.get("code_challenge_method"),
  };
}

function callback(base: string, state: string, cookie?: string) {
  return fetch(`${base}/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

let a: { base: string; server: Server };
let b: { base: string; server: Server }; // a second, independent app instance = "another replica"

beforeAll(async () => {
  a = await startApp();
  b = await startApp();
});
afterAll(() => {
  a.server.close();
  b.server.close();
});
beforeEach(() => vi.mocked(exchangeKeycloakCode).mockReset());

describe("PKCE + nonce on /api/auth/login → /api/auth/callback", () => {
  it("login sends an S256 code_challenge and a signed httpOnly transaction cookie", async () => {
    const t = await login(a.base);
    expect(t.method).toBe("S256");
    expect(t.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.setCookie.toLowerCase()).toContain("httponly");
    expect(t.setCookie.toLowerCase()).toContain("samesite=lax");
  });

  it("the verifier passed to token exchange hashes to the challenge sent at login", async () => {
    const t = await login(a.base);
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({
      accessToken: "at",
      idToken: fakeIdToken({ sub: "kc-1", nonce: t.nonce }),
    });
    const res = await callback(a.base, t.state, t.cookieHeader);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dash");
    const [code, verifier] = vi.mocked(exchangeKeycloakCode).mock.calls[0];
    expect(code).toBe("abc");
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(t.challenge);
  });

  it("CROSS-REPLICA: login on one app instance, callback on a different one, still completes with the right verifier", async () => {
    const t = await login(a.base);
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({
      accessToken: "at",
      idToken: fakeIdToken({ sub: "kc-1", nonce: t.nonce }),
    });
    const res = await callback(b.base, t.state, t.cookieHeader); // <- different instance
    expect(res.status).toBe(302);
    const verifier = vi.mocked(exchangeKeycloakCode).mock.calls[0][1];
    expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(t.challenge);
  });

  it("nonce mismatch in the ID token is rejected (401) and no session is minted", async () => {
    const t = await login(a.base);
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({
      accessToken: "at",
      idToken: fakeIdToken({ sub: "kc-1", nonce: "some-other-flows-nonce" }),
    });
    const res = await callback(a.base, t.state, t.cookieHeader);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("wa_session="))).toBe(false);
  });

  it("missing nonce claim when a transaction exists is also rejected", async () => {
    const t = await login(a.base);
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({ accessToken: "at", idToken: fakeIdToken({ sub: "kc-1" }) });
    expect((await callback(a.base, t.state, t.cookieHeader)).status).toBe(401);
  });

  it("legacy path (no transaction cookie, e.g. client-built login URL): no verifier sent, nonce not enforced — unchanged behavior", async () => {
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({ accessToken: "at", idToken: fakeIdToken({ sub: "kc-1" }) });
    const res = await callback(a.base, "legacy-state-without-cookie");
    expect(res.status).toBe(302);
    expect(vi.mocked(exchangeKeycloakCode).mock.calls[0][1]).toBeUndefined();
  });

  it("a cookie issued for a DIFFERENT state is ignored (no verifier reuse across logins)", async () => {
    const t = await login(a.base);
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({ accessToken: "at", idToken: fakeIdToken({ sub: "kc-1" }) });
    await callback(a.base, "a-different-state", t.cookieHeader);
    expect(vi.mocked(exchangeKeycloakCode).mock.calls[0][1]).toBeUndefined();
  });

  it("a tampered cookie is ignored", async () => {
    const t = await login(a.base);
    const tampered = t.cookieHeader.slice(0, -2) + (t.cookieHeader.endsWith("A") ? "B" : "A") + "x";
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({ accessToken: "at", idToken: fakeIdToken({ sub: "kc-1" }) });
    await callback(a.base, t.state, tampered);
    expect(vi.mocked(exchangeKeycloakCode).mock.calls[0][1]).toBeUndefined();
  });

  it("an expired transaction cookie is ignored", async () => {
    const expired = signOAuthTx({ state: "s1", nonce: "n1", codeVerifier: "v".repeat(43), exp: Date.now() - 1000 });
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({ accessToken: "at", idToken: fakeIdToken({ sub: "kc-1" }) });
    await callback(a.base, "s1", `${OAUTH_TX_COOKIE}=${expired}`);
    expect(vi.mocked(exchangeKeycloakCode).mock.calls[0][1]).toBeUndefined();
  });

  it("the transaction cookie is cleared once the callback runs (single use)", async () => {
    const t = await login(a.base);
    vi.mocked(exchangeKeycloakCode).mockResolvedValue({
      accessToken: "at",
      idToken: fakeIdToken({ sub: "kc-1", nonce: t.nonce }),
    });
    const res = await callback(a.base, t.state, t.cookieHeader);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_TX_COOKIE}=`));
    expect(cleared).toBeDefined();
    expect(cleared!.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
  });
});
