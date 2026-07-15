/**
 * Self-hosted JWT authentication — replaces Manus OAuth SDK.
 * Uses HS256 JWT signed with JWT_SECRET.
 * Keycloak OIDC is supported via KEYCLOAK_URL env var.
 */
import jwt from "jsonwebtoken";
import { ENV } from "./env";
import type { Request } from "express";

export interface SessionUser {
  id: string;
  openId: string;
  email: string | null;
  name: string | null;
  role: "admin" | "user";
  tenantId: string | null;
  loginMethod: string | null;
}

export interface JWTPayload {
  sub: string;        // openId
  email?: string;
  name?: string;
  role?: string;
  tenantId?: string;
  iat?: number;
  exp?: number;
}

export function signSessionToken(user: SessionUser, expiresIn = "365d"): string {
  const payload: JWTPayload = {
    sub: user.openId,
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    role: user.role,
    tenantId: user.tenantId ?? undefined,
  };
  return jwt.sign(payload, ENV.jwtSecret, { algorithm: "HS256", expiresIn } as jwt.SignOptions);
}

export function verifySessionToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, ENV.jwtSecret, { algorithms: ["HS256"] }) as JWTPayload;
  } catch {
    return null;
  }
}

/** Extract and verify session token from cookie or Authorization header */
export function getSessionUser(req: Request): JWTPayload | null {
  // 1. Try cookie
  const cookieHeader = req.headers.cookie ?? "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k, v.join("=")];
    })
  );
  const token = cookies["wa_session"] ?? cookies["session"];
  if (token) {
    const payload = verifySessionToken(token);
    if (payload) return payload;
  }
  // 2. Try Authorization: Bearer <token>
  const authHeader = req.headers.authorization ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    return verifySessionToken(bearerToken);
  }
  return null;
}

/** Build Keycloak authorization URL for login redirect */
export function buildKeycloakAuthUrl(state: string, nonce: string): string {
  const base = `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/auth`;
  const params = new URLSearchParams({
    client_id: ENV.keycloakClientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: `${ENV.appUrl}/api/auth/callback`,
    state,
    nonce,
  });
  return `${base}?${params}`;
}

/** Exchange authorization code for tokens via Keycloak */
export async function exchangeKeycloakCode(code: string): Promise<{ accessToken: string; idToken: string } | null> {
  try {
    const tokenUrl = `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ENV.keycloakClientId,
      client_secret: ENV.keycloakClientSecret,
      code,
      redirect_uri: `${ENV.appUrl}/api/auth/callback`,
    });
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { access_token: string; id_token: string };
    return { accessToken: data.access_token, idToken: data.id_token };
  } catch {
    return null;
  }
}

/** Decode Keycloak ID token (no signature verification needed — already validated by Keycloak) */
export function decodeIdToken(idToken: string): Record<string, unknown> | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
