/**
 * server/_core/keycloak-auth.ts — Keycloak OIDC authentication for the platform.
 *
 * Replaces the Manus OAuth portal with self-hosted Keycloak.
 * Handles:
 *   - PKCE authorization code flow (frontend → Keycloak → /api/oauth/callback)
 *   - JWT session cookie (HS256, same as before)
 *   - Token introspection for session validation
 *   - User sync from Keycloak user info to PostgreSQL
 *
 * Environment variables:
 *   KEYCLOAK_URL           e.g. http://keycloak:8080
 *   KEYCLOAK_REALM         e.g. wacommerce
 *   KEYCLOAK_CLIENT_ID     e.g. wacommerce-app
 *   KEYCLOAK_CLIENT_SECRET e.g. <secret>
 *   JWT_SECRET             session signing key
 */

import { ENV } from "./env";
import * as db from "../db";
import { SignJWT, jwtVerify } from "jose";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Request, Response } from "express";
import type { User } from "../../drizzle/schema";

// ── Keycloak endpoints ────────────────────────────────────────────────────────

function keycloakBase(): string {
  return `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect`;
}

export function keycloakAuthorizationUrl(redirectUri: string, state: string, codeChallenge?: string): string {
  const url = new URL(`${keycloakBase()}/auth`);
  url.searchParams.set("client_id", ENV.keycloakClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

// ── Token exchange ────────────────────────────────────────────────────────────

interface KeycloakTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface KeycloakUserInfo {
  sub: string;
  preferred_username: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email_verified?: boolean;
  realm_access?: { roles: string[] };
  tenant_id?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<KeycloakTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ENV.keycloakClientId,
    code,
    redirect_uri: redirectUri,
  });
  if (ENV.keycloakClientSecret) {
    params.set("client_secret", ENV.keycloakClientSecret);
  }
  if (codeVerifier) {
    params.set("code_verifier", codeVerifier);
  }
  const res = await fetch(`${keycloakBase()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Keycloak token exchange failed (${res.status}): ${err}`);
  }
  return res.json() as Promise<KeycloakTokenResponse>;
}

export async function getUserInfo(accessToken: string): Promise<KeycloakUserInfo> {
  const res = await fetch(`${keycloakBase()}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Keycloak userinfo failed (${res.status})`);
  return res.json() as Promise<KeycloakUserInfo>;
}

export async function introspectToken(token: string): Promise<{ active: boolean; sub?: string; preferred_username?: string; email?: string; tenant_id?: string }> {
  if (!ENV.keycloakClientSecret) return { active: false };
  const params = new URLSearchParams({
    token,
    client_id: ENV.keycloakClientId,
    client_secret: ENV.keycloakClientSecret,
  });
  const res = await fetch(`${keycloakBase()}/token/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return { active: false };
  return res.json() as Promise<{ active: boolean; sub?: string; preferred_username?: string; email?: string; tenant_id?: string }>;
}

// ── Session JWT ───────────────────────────────────────────────────────────────

function getSessionSecret(): Uint8Array {
  const secret = ENV.jwtSecret || "change-me-in-production";
  return new TextEncoder().encode(secret.padEnd(32, "0").slice(0, 32));
}

export interface KeycloakSession {
  sub: string;          // Keycloak user ID
  username: string;
  email?: string;
  name?: string;
  tenantId?: string;
  roles: string[];
}

export async function signKeycloakSession(session: KeycloakSession, expiresInMs = ONE_YEAR_MS): Promise<string> {
  const secretKey = getSessionSecret();
  const expirationSeconds = Math.floor((Date.now() + expiresInMs) / 1000);
  return new SignJWT({
    sub: session.sub,
    username: session.username,
    email: session.email,
    name: session.name,
    tenantId: session.tenantId,
    roles: session.roles,
    // Legacy compatibility fields
    openId: session.sub,
    appId: "wacommerce",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
}

export async function verifyKeycloakSession(cookieValue: string | undefined | null): Promise<KeycloakSession | null> {
  if (!cookieValue) return null;
  try {
    const secretKey = getSessionSecret();
    const { payload } = await jwtVerify(cookieValue, secretKey, { algorithms: ["HS256"] });
    const sub = payload.sub ?? (payload as any).openId;
    if (!sub || typeof sub !== "string") return null;
    return {
      sub,
      username: (payload as any).username ?? (payload as any).name ?? sub,
      email: (payload as any).email ?? undefined,
      name: (payload as any).name ?? undefined,
      tenantId: (payload as any).tenantId ?? undefined,
      roles: Array.isArray((payload as any).roles) ? (payload as any).roles : [],
    };
  } catch {
    return null;
  }
}

// ── User sync ─────────────────────────────────────────────────────────────────

export async function syncKeycloakUserToDb(userInfo: KeycloakUserInfo): Promise<User | null> {
  try {
    const name = userInfo.name ?? userInfo.preferred_username ?? userInfo.sub;
    await db.upsertUser({
      openId: userInfo.sub,
      name,
      email: userInfo.email ?? null,
      loginMethod: "keycloak",
      lastSignedIn: new Date(),
    });
    return (await db.getUserByOpenId(userInfo.sub)) ?? null;
  } catch (err) {
    console.error("[KeycloakAuth] Failed to sync user:", err);
    return null;
  }
}

// ── authenticateRequest (drop-in replacement for sdk.authenticateRequest) ─────

export type AuthenticatedUser = User & {
  keycloakSub?: string;
  tenantId?: string | null;
  roles?: string[];
};

export async function authenticateRequest(req: Request): Promise<AuthenticatedUser> {
  // 1. Try session cookie
  const cookieHeader = req.headers.cookie ?? "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), v.join("=")];
    })
  );
  let sessionToken: string | undefined = cookies[COOKIE_NAME];

  // 2. Fallback to Authorization Bearer header
  if (!sessionToken) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      sessionToken = authHeader.slice(7);
    }
  }

  // 3. Internal service token
  const internalToken = req.headers["x-internal-token"] as string | undefined;
  if (internalToken && internalToken === (process.env.PLATFORM_INTERNAL_TOKEN ?? "")) {
    // Return a synthetic system user for internal service calls
    const now = new Date();
    return {
      id: -1,
      openId: "system",
      name: "Internal Service",
      email: null,
      loginMethod: "internal",
      role: "admin",
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    } as AuthenticatedUser;
  }

  if (!sessionToken) {
    throw new Error("Missing authentication token");
  }

  // 4. Verify session JWT
  const session = await verifyKeycloakSession(sessionToken);
  if (!session) {
    // Try Keycloak introspection as fallback
    const introspected = await introspectToken(sessionToken).catch(() => ({ active: false } as any));
    if (!introspected.active) {
      throw new Error("Invalid or expired session");
    }
    // Build session from introspection
    const user = await db.getUserByOpenId(introspected.sub ?? "");
    if (!user) throw new Error("User not found");
    return { ...user, keycloakSub: introspected.sub, tenantId: introspected.tenant_id };
  }

  // 5. Load user from DB
  let user = await db.getUserByOpenId(session.sub);
  if (!user) {
    // Auto-provision user from Keycloak
    try {
      const userInfo = await getUserInfo(sessionToken);
      user = (await syncKeycloakUserToDb(userInfo)) ?? undefined;
    } catch (err) {
      console.error("[KeycloakAuth] Failed to auto-provision user:", err);
    }
  }
  if (!user) throw new Error("User not found");

  // 6. Update last sign-in
  await db.upsertUser({ openId: session.sub, lastSignedIn: new Date() }).catch(() => null);

  return {
    ...user,
    keycloakSub: session.sub,
    tenantId: session.tenantId ?? user.tenantId,
    roles: session.roles,
  };
}

// ── OAuth callback handler (Express route) ────────────────────────────────────

export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    console.error("[KeycloakAuth] OAuth error:", error, error_description);
    res.redirect(`/?error=${encodeURIComponent(error_description ?? error)}`);
    return;
  }

  if (!code) {
    res.redirect("/?error=missing_code");
    return;
  }

  try {
    const redirectUri = `${ENV.appUrl}/api/oauth/callback`;
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const userInfo = await getUserInfo(tokens.access_token);
    const user = (await syncKeycloakUserToDb(userInfo)) ?? undefined;

    if (!user) {
      res.redirect("/?error=user_sync_failed");
      return;
    }

    const session: KeycloakSession = {
      sub: userInfo.sub,
      username: userInfo.preferred_username,
      email: userInfo.email,
      name: userInfo.name,
      tenantId: userInfo.tenant_id,
      roles: userInfo.realm_access?.roles ?? [],
    };

    const sessionJwt = await signKeycloakSession(session);

    // Set session cookie
    res.cookie(COOKIE_NAME, sessionJwt, {
      httpOnly: true,
      secure: ENV.isProduction,
      sameSite: ENV.isProduction ? "none" : "lax",
      maxAge: ONE_YEAR_MS,
      path: "/",
    });

    // Redirect to app
    const redirectTo = state ? decodeURIComponent(state).split("|")[0] : "/";
    res.redirect((redirectTo ?? "/").startsWith("/") ? redirectTo : "/");
  } catch (err: any) {
    console.error("[KeycloakAuth] Callback failed:", err.message);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
}

// ── Logout handler ────────────────────────────────────────────────────────────

export async function handleLogout(req: Request, res: Response): Promise<void> {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  const keycloakLogoutUrl = `${keycloakBase()}/logout?client_id=${ENV.keycloakClientId}&post_logout_redirect_uri=${encodeURIComponent(ENV.appUrl)}`;
  res.redirect(keycloakLogoutUrl);
}
