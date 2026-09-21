/**
 * Self-hosted JWT authentication — replaces Manus OAuth SDK.
 * Uses HS256 JWT signed with JWT_SECRET.
 * Keycloak OIDC is supported via KEYCLOAK_URL env var.
 */
import jwt from "jsonwebtoken";
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from "crypto";
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
  /** W12: numeric user id (string) — used for revoke-all markers. */
  uid?: string;
  /** W12: unique token id — used for session revocation. */
  jti?: string;
  iat?: number;
  exp?: number;
}

/**
 * W12 session hardening: access-token TTL is 12h by default (was 365d),
 * overridable via the SESSION_TTL env var (jsonwebtoken `expiresIn` syntax,
 * e.g. "12h", "30m", or seconds as a number-string). Read per call so tests
 * and runtime config changes take effect without reload.
 */
export function sessionTtl(): string {
  return process.env.SESSION_TTL ?? "12h";
}

export function signSessionToken(user: SessionUser, expiresIn: string | number = sessionTtl()): string {
  const payload: JWTPayload = {
    sub: user.openId,
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    role: user.role,
    tenantId: user.tenantId ?? undefined,
    uid: user.id,
    jti: randomUUID(),
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

/**
 * QA follow-up: PKCE (RFC 7636) pair for the authorization_code flow.
 * This client is confidential (client_secret is used server-side in
 * exchangeKeycloakCode below, never exposed to the browser), which already
 * blocks the classic "stolen authorization code" attack PKCE targets on
 * PUBLIC clients — but OAuth 2.1 recommends PKCE for confidential clients
 * too, as defense-in-depth against authorization code injection (a
 * malicious/compromised AS or network handing back a code from a different
 * flow). codeVerifier is a high-entropy random string (RFC 7636 requires
 * 43-128 chars from an unreserved-char alphabet; base64url of 32 random
 * bytes is 43 chars, satisfying both bounds); codeChallenge is its S256
 * hash, sent in the initial redirect so Keycloak can verify the SAME
 * verifier is presented at token-exchange time.
 */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Login transaction carried across the Keycloak redirect round-trip in a
 * signed, short-lived, httpOnly cookie instead of per-process memory, so a
 * login started on one replica can complete on another (or after a restart).
 * An in-memory map would break exactly that: once /api/auth/login sends a
 * code_challenge, Keycloak REQUIRES the matching code_verifier at exchange
 * time, so a callback landing on a process that never saw the login would
 * fail outright. HMAC-signed with JWT_SECRET (domain-separated), bound to the
 * `state` parameter and expiry-checked on read.
 */
export const OAUTH_TX_COOKIE = "wa_oauth_tx";
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

export interface OAuthTx {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
}

function oauthTxSignature(body: string): Buffer {
  return createHmac("sha256", ENV.jwtSecret).update(`oauth-tx:${body}`).digest();
}

export function signOAuthTx(tx: OAuthTx): string {
  const body = Buffer.from(JSON.stringify(tx)).toString("base64url");
  return `${body}.${oauthTxSignature(body).toString("base64url")}`;
}

export function verifyOAuthTx(raw: string | undefined, now: number = Date.now()): OAuthTx | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = oauthTxSignature(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const tx = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthTx>;
    if (
      typeof tx.state !== "string" || typeof tx.nonce !== "string" ||
      typeof tx.codeVerifier !== "string" || typeof tx.exp !== "number" || tx.exp < now
    ) return null;
    return tx as OAuthTx;
  } catch {
    return null;
  }
}

/** Build Keycloak authorization URL for login redirect */
export function buildKeycloakAuthUrl(state: string, nonce: string, codeChallenge?: string): string {
  const base = `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/auth`;
  const params = new URLSearchParams({
    client_id: ENV.keycloakClientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: `${ENV.appUrl}/api/auth/callback`,
    state,
    nonce,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${base}?${params}`;
}

/** Exchange authorization code for tokens via Keycloak */
export async function exchangeKeycloakCode(code: string, codeVerifier?: string): Promise<{ accessToken: string; idToken: string } | null> {
  try {
    const tokenUrl = `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ENV.keycloakClientId,
      client_secret: ENV.keycloakClientSecret,
      code,
      redirect_uri: `${ENV.appUrl}/api/auth/callback`,
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);
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
