import { AXIOS_TIMEOUT_MS, COOKIE_NAME, ONE_YEAR_MS, decodeOAuthState } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import { eq, inArray } from "drizzle-orm";
import { sessionRevocations, tenantMemberships } from "../../drizzle/schema";
import * as db from "../db";
import { verifySessionToken } from "./auth";
import { ENV } from "./env";
import type {
  ExchangeTokenRequest,
  ExchangeTokenResponse,
  GetUserInfoResponse,
  GetUserInfoWithJwtRequest,
  GetUserInfoWithJwtResponse,
} from "./types/manusTypes";
// Utility function
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
const GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;

/** Session cookie issued by server/_core/oauth.ts (self-hosted Keycloak/local login). */
const WA_SESSION_COOKIE = "wa_session";

// ─── W12 session hardening: revocation registry (jti blocklist) ─────────────
// session_revocations rows are checked on every wa_session authentication.
// Results are cached for 60s to bound DB load; revocation therefore takes at
// most ~60s to propagate. Fail-closed in production on DB errors.

const REVOCATION_CACHE_TTL_MS = 60_000;
const revocationCache = new Map<string, { revoked: boolean; checkedAt: number }>();

/** Marker jti used by admin revoke-all: revokes every session of a user. */
export function userRevocationMarkerJti(userId: string | number): string {
  return `user:${userId}`;
}

/** Test hook: drop all in-memory revocation/membership caches. */
export function clearSessionCaches(): void {
  revocationCache.clear();
  membershipCache.clear();
}

async function lookupRevocations(keys: string[]): Promise<Set<string> | null> {
  const conn = await db.getDb();
  if (!conn) return null; // no database configured (unit tests) — nothing to check
  const rows = await conn
    .select({ jti: sessionRevocations.jti })
    .from(sessionRevocations)
    .where(inArray(sessionRevocations.jti, keys));
  return new Set(rows.map((r) => r.jti));
}

/**
 * Returns true when the given token jti (or the user's revoke-all marker) is
 * revoked. Cached 60s per key. On a DB error: fail-closed in production
 * (treat as revoked), fail-open with a warning elsewhere.
 */
export async function isSessionRevoked(args: {
  jti?: string | null;
  userId?: string | number | null;
}): Promise<boolean> {
  const keys: string[] = [];
  if (args.jti) keys.push(args.jti);
  if (args.userId != null && String(args.userId).length > 0) {
    keys.push(userRevocationMarkerJti(args.userId));
  }
  if (keys.length === 0) return false;

  const now = Date.now();
  const pending: string[] = [];
  for (const k of keys) {
    const hit = revocationCache.get(k);
    if (hit && now - hit.checkedAt < REVOCATION_CACHE_TTL_MS) {
      if (hit.revoked) return true;
    } else {
      pending.push(k);
    }
  }
  if (pending.length === 0) return false;

  let found: Set<string> | null = null;
  try {
    found = await lookupRevocations(pending);
  } catch (err) {
    if (ENV.isProduction) {
      console.error("[Auth] Revocation check failed in production — failing closed:", (err as Error)?.message);
      return true; // fail closed
    }
    console.warn("[Auth] Revocation check failed — failing open (non-prod):", (err as Error)?.message);
    return false;
  }
  if (found === null) return false; // DB not configured
  for (const k of pending) {
    const revoked = found.has(k);
    revocationCache.set(k, { revoked, checkedAt: now });
    if (revoked) return true;
  }
  return false;
}

/** Revoke a single token by jti (logout). expiresAt mirrors the token exp. */
export async function revokeSessionJti(
  jti: string,
  userId: string | number | null,
  expiresAt: Date,
): Promise<void> {
  const conn = await db.getDb();
  if (!conn) return;
  await conn
    .insert(sessionRevocations)
    .values({ jti, userId: userId != null ? String(userId) : null, expiresAt })
    .onConflictDoNothing();
  revocationCache.delete(jti);
}

/** Admin: revoke ALL sessions for a user (marker row, valid for `ttlMs`). */
export async function revokeAllUserSessions(
  userId: string | number,
  ttlMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  const marker = userRevocationMarkerJti(userId);
  const conn = await db.getDb();
  if (!conn) return;
  await conn
    .insert(sessionRevocations)
    .values({ jti: marker, userId: String(userId), expiresAt: new Date(Date.now() + ttlMs) })
    .onConflictDoNothing();
  revocationCache.delete(marker);
}

// ─── W12 tenancy: per-user membership snapshot (for assertTenantAccess) ──────
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
const membershipCache = new Map<string, { tenants: string[]; checkedAt: number }>();

/**
 * Tenant ids the user is a member of (tenant_memberships), cached 60s.
 * Fails open to [] — assertTenantAccess then simply falls through to its
 * existing FORBIDDEN behavior, so a DB error can never grant access.
 */
export async function getUserMembershipTenantIds(userId: string | number): Promise<string[]> {
  const key = String(userId);
  const now = Date.now();
  const hit = membershipCache.get(key);
  if (hit && now - hit.checkedAt < MEMBERSHIP_CACHE_TTL_MS) return hit.tenants;
  try {
    const conn = await db.getDb();
    if (!conn) return [];
    const rows = await conn
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, key));
    const tenants = rows.map((r) => r.tenantId);
    membershipCache.set(key, { tenants, checkedAt: now });
    return tenants;
  } catch (err) {
    console.warn("[Auth] Membership lookup failed:", (err as Error)?.message);
    return [];
  }
}

/** Attach the membership snapshot to an authenticated user. */
async function withMemberships<T extends User>(user: T): Promise<T & { memberships: string[] }> {
  const memberships = await getUserMembershipTenantIds(user.id);
  return { ...user, memberships };
}

// ─── Keycloak JWKS (RS256 Bearer token verification) ─────────────────────────
// jose is already a project dependency; no new packages are introduced.

type KeycloakTokenClaims = {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  tenant_id?: string;
};

let keycloakJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Keycloak verification is enabled only when KEYCLOAK_URL is explicitly set. */
function keycloakEnabled(): boolean {
  return isNonEmptyString(process.env.KEYCLOAK_URL);
}

function getKeycloakJWKS() {
  if (!keycloakEnabled()) return null;
  if (!keycloakJWKS) {
    keycloakJWKS = createRemoteJWKSet(
      new URL(
        `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/certs`
      )
    );
  }
  return keycloakJWKS;
}

/**
 * Verify a Keycloak-issued RS256 access token against the realm JWKS,
 * enforcing the issuer and expiry. Returns null when Keycloak is not
 * configured or the token fails verification.
 */
// Exported for direct unit-testing of the JWT validation policy
// (server/jwtStructure.test.ts). Production code goes through
// sdk.authenticateRequest.
export async function verifyKeycloakBearerToken(
  token: string
): Promise<KeycloakTokenClaims | null> {
  const jwks = getKeycloakJWKS();
  if (!jwks) return null;
  try {
    // When KEYCLOAK_AUDIENCE is set, require the token's `aud` claim to match
    // (mirrors the gateway's Keycloak audience check). Unset = aud not enforced.
    const audience = process.env.KEYCLOAK_AUDIENCE;
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: `${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}`,
      ...(isNonEmptyString(audience) ? { audience } : {}),
    });
    if (!isNonEmptyString(payload.sub)) return null;
    return payload as unknown as KeycloakTokenClaims;
  } catch {
    return null;
  }
}

class OAuthService {
  constructor(private client: ReturnType<typeof axios.create>) {
    console.log("[OAuth] Initialized with baseURL:", ENV.keycloakUrl);
    if (!ENV.keycloakUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }

  private decodeState(state: string): string {
    return decodeOAuthState(state).redirectUri;
  }

  async getTokenByCode(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    const payload: ExchangeTokenRequest = {
      clientId: "wacommerce",
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state),
    };

    const { data } = await this.client.post<ExchangeTokenResponse>(
      EXCHANGE_TOKEN_PATH,
      payload
    );

    return data;
  }

  async getUserInfoByToken(
    token: ExchangeTokenResponse
  ): Promise<GetUserInfoResponse> {
    const { data } = await this.client.post<GetUserInfoResponse>(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken,
      }
    );

    return data;
  }
}

const createOAuthHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.keycloakUrl,
    timeout: AXIOS_TIMEOUT_MS,
  });

class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OAuthService;

  constructor(client: AxiosInstance = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }

  private deriveLoginMethod(
    platforms: unknown,
    fallback: string | null | undefined
  ): string | null {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set<string>(
      platforms.filter((p): p is string => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (
      set.has("REGISTERED_PLATFORM_MICROSOFT") ||
      set.has("REGISTERED_PLATFORM_AZURE")
    )
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }

  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    return this.oauthService.getTokenByCode(code, state);
  }

  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken: string): Promise<GetUserInfoResponse> {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken,
    } as ExchangeTokenResponse);
    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoResponse;
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: "wacommerce",
        name: options.name || "",
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId: string; appId: string; name: string } | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name } = payload as Record<string, unknown>;

      if (
        !isNonEmptyString(openId) ||
        !isNonEmptyString(appId) ||
        !isNonEmptyString(name)
      ) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      return {
        openId,
        appId,
        name,
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async getUserInfoWithJwt(
    jwtToken: string
  ): Promise<GetUserInfoWithJwtResponse> {
    const payload: GetUserInfoWithJwtRequest = {
      jwtToken,
      projectId: "wacommerce",
    };

    const { data } = await this.client.post<GetUserInfoWithJwtResponse>(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );

    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoWithJwtResponse;
  }

  /**
   * Resolve a user from the local database by openId, auto-provisioning from
   * the verified token claims when the user does not exist yet. This is the
   * shared mapping used by every supported credential type so all of them
   * yield the same User shape.
   */
  private async resolveLocalUser(
    openId: string,
    hints: { name?: string | null; email?: string | null; loginMethod?: string | null } = {}
  ): Promise<AuthenticatedUser> {
    const signedInAt = new Date();
    let user = await db.getUserByOpenId(openId);

    if (!user) {
      try {
        await db.upsertUser({
          openId,
          name: hints.name ?? null,
          email: hints.email ?? null,
          loginMethod: hints.loginMethod ?? null,
          lastSignedIn: signedInAt,
        });
        user = await db.getUserByOpenId(openId);
      } catch (error) {
        console.error("[Auth] Failed to provision user:", error);
        throw ForbiddenError("Failed to provision user");
      }
    }

    if (!user) {
      throw ForbiddenError("User not found");
    }

    await db.upsertUser({ openId: user.openId, lastSignedIn: signedInAt });
    return user;
  }

  /**
   * Authenticate an incoming request. Supported credentials, in order:
   *   1. `wa_session` cookie — HS256 JWT issued by server/_core/oauth.ts
   *      (self-hosted Keycloak OIDC / local dev login), signed with JWT_SECRET.
   *   2. `Authorization: Bearer` — a Keycloak RS256 access token (verified
   *      against the realm JWKS when KEYCLOAK_URL is set), or a `wa_session`
   *      JWT passed as a bearer token.
   *   3. Legacy `app_session_id` cookie — HS256 JWT ({openId, appId, name})
   *      signed with the cookie secret (jose), kept for backwards compat.
   */
  async authenticateRequest(req: Request): Promise<AuthenticatedUser> {
    const cookies = this.parseCookies(req.headers.cookie);

    // 1. Self-hosted session cookie issued by server/_core/oauth.ts.
    const waSession = cookies.get(WA_SESSION_COOKIE) ?? cookies.get("session");
    if (waSession) {
      const payload = verifySessionToken(waSession);
      if (payload && isNonEmptyString(payload.sub)) {
        // W12: reject revoked tokens (logout / admin revoke-all).
        if (await isSessionRevoked({ jti: payload.jti ?? null, userId: payload.uid ?? null })) {
          throw ForbiddenError("Session revoked");
        }
        return withMemberships(await this.resolveLocalUser(payload.sub, {
          name: payload.name ?? null,
          email: payload.email ?? null,
          loginMethod: "keycloak",
        }));
      }
    }

    // 2. Authorization: Bearer — Keycloak RS256 access token, or a
    //    wa_session JWT presented as a bearer token.
    const authHeader = req.headers.authorization;
    let bearerToken: string | undefined;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      bearerToken = authHeader.slice(7);
    }
    if (bearerToken) {
      const kcClaims = await verifyKeycloakBearerToken(bearerToken);
      if (kcClaims) {
        return this.resolveLocalUser(kcClaims.sub, {
          name: kcClaims.name ?? kcClaims.preferred_username ?? null,
          email: kcClaims.email ?? null,
          loginMethod: "keycloak",
        });
      }
      const waPayload = verifySessionToken(bearerToken);
      if (waPayload && isNonEmptyString(waPayload.sub)) {
        // W12: reject revoked tokens (logout / admin revoke-all).
        if (await isSessionRevoked({ jti: waPayload.jti ?? null, userId: waPayload.uid ?? null })) {
          throw ForbiddenError("Session revoked");
        }
        return withMemberships(await this.resolveLocalUser(waPayload.sub, {
          name: waPayload.name ?? null,
          email: waPayload.email ?? null,
          loginMethod: "keycloak",
        }));
      }
    }

    // 3. Legacy app_session_id cookie (jose HS256 with the cookie secret).
    //    The Bearer header is also accepted as a legacy session token
    //    (Preview auto-login via sessionStorage) when it is not a Keycloak or
    //    wa_session token.
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      sessionToken = bearerToken;
    }

    // W30 (V3#3): local cron fast-path. When CRON_JWT is configured, the
    // shipped scheduler (services/scheduler) authenticates with an HS256
    // token signed by that shared secret instead of the external OAuth
    // GetUserInfoWithJwt exchange (which only exists on Manus-hosted
    // deploys). Fail-closed: a token whose openId claims the cron_ prefix
    // but fails verification or lacks task_uid is rejected outright.
    const cronSecret = (process.env.CRON_JWT ?? "").trim();
    if (cronSecret && sessionToken) {
      try {
        const { payload } = await jwtVerify(
          sessionToken,
          new TextEncoder().encode(cronSecret),
          { algorithms: ["HS256"] },
        );
        const claims = payload as Record<string, unknown>;
        if (isNonEmptyString(claims.openId) && claims.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
          const taskUid = claims.task_uid ?? claims.taskUid;
          if (!isNonEmptyString(taskUid)) {
            throw ForbiddenError("Cron session missing task_uid");
          }
          return buildCronUser({
            openId: claims.openId,
            taskUid,
            name: isNonEmptyString(claims.name) ? claims.name : "Cron Scheduler",
          } as GetUserInfoWithJwtResponse);
        }
      } catch (e) {
        if (e instanceof ForbiddenError) throw e;
        // Not a cron token (or bad signature) — fall through to normal auth.
      }
    }

    const session = await this.verifySession(sessionToken);

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }

    const sessionUserId = session.openId;
    const signedInAt = new Date();
    let user = await db.getUserByOpenId(sessionUserId);

    // If user not in DB, sync from OAuth server automatically
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await db.upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt,
        });
        user = await db.getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }

    if (!user) {
      throw ForbiddenError("User not found");
    }

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    return withMemberships(user);
  }
}

const CRON_OPEN_ID_PREFIX = "cron_";

/** Result of `sdk.authenticateRequest`. Cron callbacks set `isCron=true` and `taskUid`; see `/home/ubuntu/skills/webdev-periodic-updates/SKILL.md`. */
export type AuthenticatedUser = User & {
  taskUid?: string;
  isCron?: boolean;
  /** W12: tenant ids the user is a member of (tenant_memberships, cached 60s). */
  memberships?: string[];
};

function buildCronUser(
  userInfo: GetUserInfoWithJwtResponse
): AuthenticatedUser {
  const now = new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? undefined,
    isCron: true,
  } as AuthenticatedUser;
}

export const sdk = new SDKServer();
