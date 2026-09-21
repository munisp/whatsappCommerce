/**
 * Self-hosted auth routes — replaces Manus OAuth.
 * Supports:
 *   1. Keycloak OIDC authorization_code flow  (/api/auth/login, /api/auth/callback)
 *   2. Local email/password login             (/api/auth/local)
 *   3. Session info                           (/api/auth/me)
 *   4. Logout                                 (/api/auth/logout)
 *   5. Legacy Manus callback redirect         (/api/oauth/callback)
 */
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { sendWelcomeEmail } from "../services/email/resend";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import {
  OAUTH_TX_COOKIE,
  OAUTH_TX_TTL_MS,
  buildKeycloakAuthUrl,
  decodeIdToken,
  exchangeKeycloakCode,
  generatePkcePair,
  signOAuthTx,
  signSessionToken,
  verifyOAuthTx,
  verifySessionToken,
} from "./auth";

const SESSION_COOKIE = "wa_session";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function getQueryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Where to send the browser after login: a same-origin PATH, or "/". Anything else — an absolute URL, a
 * protocol-relative "//host", a "javascript:" URI — would turn the post-login redirect into an open redirect
 * (`/api/auth/login?redirect=https://evil.example` is a link an attacker can hand a victim). Browsers treat "\" like
 * "/" and silently drop tab/CR/LF inside a URL, so "/\evil.example" and "/<TAB>/evil.example" both resolve to
 * "//evil.example" — both are refused too.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}

/** The callback was not for a login THIS browser started (or it expired). Fail closed; never contact Keycloak. */
function rejectLoginSession(res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.status(400).format({
    json: () => res.json({ error: "login_session_invalid", message: "This sign-in was not started from this browser, or it expired.", login: "/api/auth/login" }),
    html: () => res.send('<!doctype html><meta charset="utf-8"><title>Sign-in expired</title><p>Your sign-in session expired, or it was not started from this browser.</p><p><a href="/api/auth/login">Sign in again</a></p>'),
  });
}

export function registerOAuthRoutes(app: Express) {
  // 1. Initiate Keycloak login
  app.get("/api/auth/login", (req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = generatePkcePair();
    // QA follow-up: PKCE verifier + OIDC nonce ride in a signed httpOnly
    // cookie (see signOAuthTx) rather than per-process memory — Keycloak
    // requires the verifier at exchange time once a challenge was sent, so
    // an in-memory store would fail every login whose callback lands on a
    // different replica (or after a restart).
    res.cookie(
      OAUTH_TX_COOKIE,
      signOAuthTx({ state, nonce, codeVerifier, exp: Date.now() + OAUTH_TX_TTL_MS }),
      { ...getSessionCookieOptions(req), maxAge: OAUTH_TX_TTL_MS },
    );
    const redirectTo = safeReturnTo(getQueryParam(req, "redirect"));
    const stateWithRedirect = `${state}:${encodeURIComponent(redirectTo)}`;
    const authUrl = buildKeycloakAuthUrl(stateWithRedirect, nonce, codeChallenge);
    res.redirect(302, authUrl);
  });

  // 2. Keycloak callback
  app.get("/api/auth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const stateParam = getQueryParam(req, "state") ?? "";
    const [state, encodedRedirect] = stateParam.split(":");
    if (!code || !state) { res.status(400).json({ error: "code and state required" }); return; }

    // QA-020 (login CSRF): this callback may only complete a login THIS browser started. The proof is the signed
    // transaction cookie set by /api/auth/login, bound to `state`. Without it, anyone who completes a login at
    // Keycloak could hand a victim a crafted /api/auth/callback?code=…&state=… link and get the victim's browser signed
    // in AS THE ATTACKER. A missing, tampered, expired or wrong-state cookie is therefore a hard failure — earlier
    // this fell through as "legacy behaviour", which is exactly the hole. (An attacker cannot mint a valid cookie:
    // it is HMAC-signed, httpOnly, and set only on a response to the victim's own request.) Cleared on every path:
    // single use.
    const tx = verifyOAuthTx(readCookie(req, OAUTH_TX_COOKIE));
    res.clearCookie(OAUTH_TX_COOKIE, { path: "/" });
    if (!tx || tx.state !== state) { rejectLoginSession(res); return; }

    // The redirect rides in the unsigned suffix of `state`. Login already sanitised it; it is sanitised again here
    // because this is the value the browser is finally sent to. A malformed escape must not throw outside the try.
    let redirectTo = "/";
    if (encodedRedirect) {
      try { redirectTo = safeReturnTo(decodeURIComponent(encodedRedirect)); } catch { /* malformed escape → "/" */ }
    }
    try {
      const tokens = await exchangeKeycloakCode(code, tx.codeVerifier);
      if (!tokens) { res.status(401).json({ error: "Token exchange failed" }); return; }
      const claims = decodeIdToken(tokens.idToken) as Record<string, string> | null;
      if (!claims?.sub) { res.status(400).json({ error: "Missing sub in ID token" }); return; }
      // The OIDC nonce sent at /api/auth/login must come back in the ID token: it binds the token to this login.
      if (claims.nonce !== tx.nonce) {
        res.status(401).json({ error: "Nonce mismatch" });
        return;
      }
      const isNewUser = !(await db.getUserByOpenId(claims.sub));
      await db.upsertUser({ openId: claims.sub, name: claims.name ?? claims.preferred_username ?? null, email: claims.email ?? null, loginMethod: "keycloak", lastSignedIn: new Date() });
      const user = await db.getUserByOpenId(claims.sub);
      const sessionToken = signSessionToken({ id: String(user?.id ?? 0), openId: claims.sub, email: claims.email ?? null, name: claims.name ?? null, role: (user?.role as "admin" | "user") ?? "user", tenantId: user?.tenantId ?? null, loginMethod: "keycloak" });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      // Fire-and-forget — a failed welcome email must never block login.
      if (isNewUser && claims.email) {
        sendWelcomeEmail(claims.email, claims.name ?? claims.preferred_username ?? null).catch(err =>
          console.warn("[Auth] Welcome email failed", err)
        );
      }
      res.redirect(302, redirectTo);
    } catch (error) { console.error("[Auth] Callback failed", error); res.status(500).json({ error: "Auth callback failed" }); }
  });

  // 3. Local login
  app.post("/api/auth/local", async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) { res.status(400).json({ error: "email and password required" }); return; }

    // The users table has no password-hash column — this platform has no
    // local-password credential concept (auth is Keycloak OIDC or phone OTP).
    // The passwordless path below exists ONLY for local development and must
    // be explicitly enabled with ENABLE_LOCAL_AUTH=true. This is deliberately
    // independent of NODE_ENV so a misconfigured deploy (e.g. NODE_ENV unset)
    // can never silently enable the "any password creates an account" path.
    if (process.env.ENABLE_LOCAL_AUTH !== "true") {
      res.status(501).json({ error: "Local password login is not supported. Use SSO or phone OTP login." });
      return;
    }
    console.warn(`[Auth] DEV-ONLY local login bypass for ${email} — no password verification is performed (ENABLE_LOCAL_AUTH=true)`);

    try {
      await db.upsertUser({ openId: `local:${email}`, email, name: email.split("@")[0], loginMethod: "local", lastSignedIn: new Date() });
      const user = await db.getUserByOpenId(`local:${email}`);
      const sessionToken = signSessionToken({ id: String(user?.id ?? 0), openId: `local:${email}`, email, name: user?.name ?? null, role: (user?.role as "admin" | "user") ?? "user", tenantId: user?.tenantId ?? null, loginMethod: "local" });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ ok: true });
    } catch (error) { console.error("[Auth] Local login failed", error); res.status(500).json({ error: "Login failed" }); }
  });

  // 4. Session info
  app.get("/api/auth/me", async (req: Request, res: Response) => {
    const cookies = Object.fromEntries((req.headers.cookie ?? "").split(";").map(c => { const [k, ...v] = c.trim().split("="); return [k, v.join("=")]; }));
    const token = cookies[SESSION_COOKIE];
    if (!token) { res.json({ user: null }); return; }
    const payload = verifySessionToken(token);
    if (!payload) { res.json({ user: null }); return; }
    const user = await db.getUserByOpenId(payload.sub);
    res.json({ user: user ?? null });
  });

  // 5. Logout — W30 (V2#13): revoke the token's jti in the revocation
  // registry so the bearer token dies immediately instead of remaining
  // valid until its natural expiry (the cookie clear alone is client-side
  // theatre — a copied token kept working for its full TTL).
  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    try {
      const cookieHeader = req.headers.cookie ?? "";
      const cookies = Object.fromEntries(
        cookieHeader.split(";").map(c => { const [k, ...v] = c.trim().split("="); return [k, v.join("=")]; })
      );
      const authHeader = req.headers.authorization ?? "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const token = cookies[SESSION_COOKIE] ?? cookies["session"] ?? bearer;
      if (token) {
        const payload = verifySessionToken(token);
        if (payload?.jti) {
          const { revokeSessionJti } = await import("./sdk");
          await revokeSessionJti(
            payload.jti,
            payload.uid ?? null,
            payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + ONE_YEAR_MS),
          );
        }
      }
    } catch (err) {
      // Logout must never fail loudly — the cookie is cleared regardless.
      console.warn("[Auth] Logout revocation failed:", (err as Error)?.message);
    }
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // Legacy Manus OAuth callback redirect
  app.get("/api/oauth/callback", (req: Request, res: Response) => {
    res.redirect(302, `/api/auth/callback?${new URLSearchParams(req.query as Record<string, string>)}`);
  });
}
