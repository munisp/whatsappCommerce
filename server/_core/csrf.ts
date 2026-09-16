/**
 * W39 (PLT-3) — CSRF origin-verification middleware.
 *
 * Layer 2 of the CSRF defense (layer 1 is SameSite=Lax on the session
 * cookie, see server/_core/cookies.ts). For MUTATING requests that carry an
 * ambient session cookie we require an Origin (or Referer) header whose
 * host matches the request Host (same-origin) or an explicitly allowlisted
 * CORS origin. Cross-site form POSTs / top-level cross-site requests that
 * still manage to present a cookie are rejected with 403.
 *
 * Requests that are NOT CSRF-able are passed through untouched:
 *   - non-mutating methods (GET/HEAD/OPTIONS)
 *   - paths that authenticate out-of-band (webhook signatures, internal
 *     service-to-service endpoints) — see EXEMPT_PATH_PREFIXES
 *   - requests with no session cookie (nothing ambient for the browser to
 *     attach — e.g. public token endpoints like /ussd, /api/evidence/:token)
 *   - requests presenting a non-cookie credential: Authorization bearer
 *     (cron JWTs, Keycloak tokens) or the internal service headers
 *     (X-Internal-Api-Key / X-Internal-Token). Browsers cannot attach these
 *     cross-origin without a CORS preflight the server explicitly allows.
 *
 * Pure/exported helpers so vitest + simulation journeys can exercise the
 * decision logic without booting the whole server.
 */
import type { NextFunction, Request, Response } from "express";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cookie names that authenticate a session (server/_core/sdk.ts). */
const SESSION_COOKIE_NAMES = ["wa_session", "session", "app_session_id"];

/**
 * Paths whose authentication is independent of the browser session cookie
 * (HMAC-signed webhooks, internal-token service endpoints). These must keep
 * working for non-browser callers that send no Origin header at all.
 */
export const CSRF_EXEMPT_PATH_PREFIXES = [
  "/api/webhooks/",
  "/integrations/",
  "/api/internal/",
];

/**
 * Exact paths exempt from the check: the auth lifecycle endpoints must work
 * for non-browser clients (curl, mobile shells, scripts) that legitimately
 * hold a session cookie but send no Origin. Login-CSRF / logout-CSRF are
 * out of scope for this control (no state is mutated beyond the caller's
 * own session).
 */
export const CSRF_EXEMPT_EXACT_PATHS = [
  "/api/auth/local",
  "/api/auth/logout",
];

/** Internal service-to-service headers (non-browser credentials). */
const INTERNAL_AUTH_HEADERS = ["x-internal-api-key", "x-internal-token"];

export interface CsrfProtectionOptions {
  /** Extra origins allowed to send cookie-authenticated mutations
   *  (typically the CORS_ORIGIN allowlist). */
  allowedOrigins?: string[];
  /** Path prefixes exempt from the origin check. */
  exemptPathPrefixes?: string[];
}

/** True when the request carries any ambient session cookie. */
export function hasSessionCookie(req: Request): boolean {
  const header = req.headers.cookie;
  if (!header) return false;
  return SESSION_COOKIE_NAMES.some(
    (name) => new RegExp(`(?:^|;)\\s*${name}=`).test(header),
  );
}

/** True when the request presents a non-cookie credential. */
export function hasNonCookieCredential(req: Request): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.trim().length > 0) return true;
  return INTERNAL_AUTH_HEADERS.some((h) => {
    const v = req.headers[h];
    return typeof v === "string" && v.trim().length > 0;
  });
}

export interface OriginCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Evaluate whether a cookie-authenticated mutating request's Origin/Referer
 * is acceptable: same-host as the request (same-origin tRPC clients) or in
 * the explicit allowlist.
 */
export function evaluateRequestOrigin(
  req: Pick<Request, "headers">,
  allowedOrigins: string[] = [],
): OriginCheckResult {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source || typeof source !== "string") {
    return { ok: false, reason: "missing Origin/Referer header" };
  }
  let originHost: string;
  try {
    originHost = new URL(source).host.toLowerCase();
  } catch {
    return { ok: false, reason: "unparseable Origin/Referer header" };
  }
  const requestHost = (req.headers.host ?? "").toLowerCase();
  if (requestHost && originHost === requestHost) return { ok: true };
  const origin = source.startsWith("http") ? new URL(source).origin : null;
  if (origin && allowedOrigins.includes(origin)) return { ok: true };
  return {
    ok: false,
    reason: `origin '${originHost}' does not match host '${requestHost}'`,
  };
}

export function createCsrfProtection(opts: CsrfProtectionOptions = {}) {
  const allowedOrigins = (opts.allowedOrigins ?? []).filter((o) => o && o !== "*");
  const exempt = opts.exemptPathPrefixes ?? CSRF_EXEMPT_PATH_PREFIXES;
  return function csrfProtection(req: Request, res: Response, next: NextFunction) {
    if (!MUTATING_METHODS.has(req.method)) return next();
    if (exempt.some((p) => req.path.startsWith(p))) return next();
    if (CSRF_EXEMPT_EXACT_PATHS.includes(req.path)) return next();
    if (hasNonCookieCredential(req)) return next();
    if (!hasSessionCookie(req)) return next();
    const verdict = evaluateRequestOrigin(req, allowedOrigins);
    if (!verdict.ok) {
      res.status(403).json({ error: "csrf-check-failed", reason: verdict.reason });
      return;
    }
    next();
  };
}
