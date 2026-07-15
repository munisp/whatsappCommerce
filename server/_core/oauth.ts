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
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import {
  buildKeycloakAuthUrl,
  decodeIdToken,
  exchangeKeycloakCode,
  signSessionToken,
  verifySessionToken,
} from "./auth";

const SESSION_COOKIE = "wa_session";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const pendingNonces = new Map<string, string>();

function getQueryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

export function registerOAuthRoutes(app: Express) {
  // 1. Initiate Keycloak login
  app.get("/api/auth/login", (req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    pendingNonces.set(state, nonce);
    setTimeout(() => pendingNonces.delete(state), 10 * 60 * 1000);
    const redirectTo = getQueryParam(req, "redirect") ?? "/";
    const stateWithRedirect = `${state}:${encodeURIComponent(redirectTo)}`;
    const authUrl = buildKeycloakAuthUrl(stateWithRedirect, nonce);
    res.redirect(302, authUrl);
  });

  // 2. Keycloak callback
  app.get("/api/auth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const stateParam = getQueryParam(req, "state") ?? "";
    const [state, encodedRedirect] = stateParam.split(":");
    const redirectTo = encodedRedirect ? decodeURIComponent(encodedRedirect) : "/";
    if (!code || !state) { res.status(400).json({ error: "code and state required" }); return; }
    try {
      const tokens = await exchangeKeycloakCode(code);
      if (!tokens) { res.status(401).json({ error: "Token exchange failed" }); return; }
      const claims = decodeIdToken(tokens.idToken) as Record<string, string> | null;
      if (!claims?.sub) { res.status(400).json({ error: "Missing sub in ID token" }); return; }
      await db.upsertUser({ openId: claims.sub, name: claims.name ?? claims.preferred_username ?? null, email: claims.email ?? null, loginMethod: "keycloak", lastSignedIn: new Date() });
      const user = await db.getUserByOpenId(claims.sub);
      const sessionToken = signSessionToken({ id: String(user?.id ?? 0), openId: claims.sub, email: claims.email ?? null, name: claims.name ?? null, role: (user?.role as "admin" | "user") ?? "user", tenantId: user?.tenantId ?? null, loginMethod: "keycloak" });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, redirectTo);
    } catch (error) { console.error("[Auth] Callback failed", error); res.status(500).json({ error: "Auth callback failed" }); }
  });

  // 3. Local login
  app.post("/api/auth/local", async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) { res.status(400).json({ error: "email and password required" }); return; }
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

  // 5. Logout
  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // Legacy Manus OAuth callback redirect
  app.get("/api/oauth/callback", (req: Request, res: Response) => {
    res.redirect(302, `/api/auth/callback?${new URLSearchParams(req.query as Record<string, string>)}`);
  });
}
