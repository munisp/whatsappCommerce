/**
 * W39 (PLT-3) — CSRF defense unit tests.
 *
 * Covers the two layers:
 *   1. Session cookie is issued SameSite=Lax (server/_core/cookies.ts).
 *   2. Origin/Referer verification middleware (server/_core/csrf.ts):
 *      cross-origin cookie-authenticated mutations → 403; same-origin OK;
 *      webhook paths / internal-token / bearer / cookie-less requests pass.
 */
import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { getSessionCookieOptions } from "./cookies";
import {
  createCsrfProtection,
  evaluateRequestOrigin,
  hasSessionCookie,
  hasNonCookieCredential,
  CSRF_EXEMPT_PATH_PREFIXES,
} from "./csrf";

function mockReq(overrides: Record<string, any> = {}): Request {
  return {
    method: "POST",
    path: "/api/trpc/orders.create",
    headers: {
      host: "shop.example.com",
      cookie: "wa_session=abc123",
      origin: "https://shop.example.com",
      ...overrides.headers,
    },
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  const state: { status?: number; body?: any } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: any) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

describe("session cookie options (PLT-3 layer 1)", () => {
  it("issues SameSite=Lax (not None) with httpOnly", () => {
    const req = { protocol: "https", headers: {} } as unknown as Request;
    const opts = getSessionCookieOptions(req);
    expect(opts.sameSite).toBe("lax");
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
  });
});

describe("helpers", () => {
  it("detects the session cookie among others", () => {
    expect(hasSessionCookie(mockReq())).toBe(true);
    expect(hasSessionCookie(mockReq({ headers: { host: "h", cookie: "other=1" } }))).toBe(false);
    expect(hasSessionCookie(mockReq({ headers: { host: "h" } }))).toBe(false);
    // legacy cookie names also count
    expect(hasSessionCookie(mockReq({ headers: { host: "h", cookie: "app_session_id=x" } }))).toBe(true);
  });

  it("detects non-cookie credentials", () => {
    expect(hasNonCookieCredential(mockReq())).toBe(false);
    expect(hasNonCookieCredential(mockReq({ headers: { authorization: "Bearer t" } }))).toBe(true);
    expect(hasNonCookieCredential(mockReq({ headers: { "x-internal-api-key": "k" } }))).toBe(true);
    expect(hasNonCookieCredential(mockReq({ headers: { "x-internal-token": "k" } }))).toBe(true);
  });

  it("evaluateRequestOrigin: same-host origin ok, foreign origin rejected, allowlist honored", () => {
    expect(evaluateRequestOrigin(mockReq()).ok).toBe(true);
    const foreign = evaluateRequestOrigin(mockReq({ headers: { host: "shop.example.com", origin: "https://evil.example" } }));
    expect(foreign.ok).toBe(false);
    const allowed = evaluateRequestOrigin(
      mockReq({ headers: { host: "api.example.com", origin: "https://app.example.com" } }),
      ["https://app.example.com"],
    );
    expect(allowed.ok).toBe(true);
    // Referer fallback when Origin absent
    expect(evaluateRequestOrigin(mockReq({ headers: { host: "shop.example.com", referer: "https://shop.example.com/page" } })).ok).toBe(true);
    // Missing both → rejected
    expect(evaluateRequestOrigin(mockReq({ headers: { host: "shop.example.com" } })).ok).toBe(false);
  });
});

describe("csrfProtection middleware (PLT-3 layer 2)", () => {
  const mw = createCsrfProtection({ allowedOrigins: [] });

  it("cross-origin POST with session cookie → 403 csrf-check-failed", () => {
    const { res, state } = mockRes();
    let called = false;
    mw(mockReq({ headers: { host: "shop.example.com", cookie: "wa_session=abc", origin: "https://evil.example" } }), res, () => { called = true; });
    expect(called).toBe(false);
    expect(state.status).toBe(403);
    expect(state.body?.error).toBe("csrf-check-failed");
  });

  it("same-origin POST with session cookie → next()", () => {
    const { res, state } = mockRes();
    let called = false;
    mw(mockReq(), res, () => { called = true; });
    expect(called).toBe(true);
    expect(state.status).toBeUndefined();
  });

  it("GET with session cookie and no Origin → next() (non-mutating)", () => {
    let called = false;
    mw(mockReq({ method: "GET", headers: { host: "shop.example.com", cookie: "wa_session=abc" } }), mockRes().res, () => { called = true; });
    expect(called).toBe(true);
  });

  it("webhook paths exempt even with a cookie and foreign origin", () => {
    for (const p of CSRF_EXEMPT_PATH_PREFIXES) {
      let called = false;
      mw(
        mockReq({ path: `${p}paystack`, headers: { host: "shop.example.com", cookie: "wa_session=abc", origin: "https://evil.example" } }),
        mockRes().res,
        () => { called = true; },
      );
      expect(called, `path ${p} should be exempt`).toBe(true);
    }
  });

  it("internal-token service call exempt (no Origin needed)", () => {
    let called = false;
    mw(
      mockReq({ path: "/api/internal/events", headers: { host: "shop.example.com", cookie: "wa_session=abc", "x-internal-api-key": "k" } }),
      mockRes().res,
      () => { called = true; },
    );
    expect(called).toBe(true);
  });

  it("bearer-token request exempt (not ambient auth)", () => {
    let called = false;
    mw(
      mockReq({ headers: { host: "shop.example.com", cookie: "wa_session=abc", authorization: "Bearer cron.jwt" } }),
      mockRes().res,
      () => { called = true; },
    );
    expect(called).toBe(true);
  });

  it("no session cookie → next() even with foreign origin (public token endpoints)", () => {
    let called = false;
    mw(
      mockReq({ path: "/ussd", headers: { host: "shop.example.com", origin: "https://evil.example" } }),
      mockRes().res,
      () => { called = true; },
    );
    expect(called).toBe(true);
  });

  it("auth lifecycle endpoints exempt (logout must work for non-browser clients)", () => {
    for (const p of ["/api/auth/logout", "/api/auth/local"]) {
      let called = false;
      mw(mockReq({ path: p, headers: { host: "shop.example.com", cookie: "wa_session=abc" } }), mockRes().res, () => { called = true; });
      expect(called, `${p} should be exempt`).toBe(true);
    }
  });

  it("cookie-authed mutation with no Origin and no Referer → 403", () => {
    const { res, state } = mockRes();
    let called = false;
    mw(mockReq({ headers: { host: "shop.example.com", cookie: "wa_session=abc" } }), res, () => { called = true; });
    expect(called).toBe(false);
    expect(state.status).toBe(403);
  });
});
