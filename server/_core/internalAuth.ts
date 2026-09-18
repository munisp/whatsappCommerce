/**
 * === W46 platform-p2 (PLT-15) ===
 * server/_core/internalAuth.ts — HMAC-signed internal service requests.
 *
 * The pre-W46 internal auth was a single static shared bearer
 * (X-Internal-Token / X-Internal-Api-Key == INTERNAL_API_KEY): no timestamp,
 * no body binding, no rotation (W45 residual PLT-15). This module adds an
 * ADDITIVE alternative alongside the bearer: requests carry
 *
 *   X-Internal-Key-Id:    <kid>            (key version)
 *   X-Internal-Ts:        <unix seconds>
 *   X-Internal-Signature: hex HMAC-SHA256 over
 *                         `${ts}\n${METHOD}\n${path}\n${sha256hex(rawBody)}`
 *
 * Key versioning + rotation:
 *   INTERNAL_HMAC_KEYS    JSON map { "<kid>": "<hex-or-utf8 secret>" }
 *   INTERNAL_HMAC_KEY_ID  active kid used when signing outbound requests
 *   (legacy single-secret fallback: INTERNAL_HMAC_SECRET +
 *    INTERNAL_HMAC_KEY_ID, default kid "v1")
 * Verification resolves the key by the presented kid, so old and new keys
 * coexist during rotation — mirroring the W42 keyring `v2:<kid>` doctrine.
 *
 * Fail-closed in production for sensitive routes: when HMAC keys ARE
 * configured, a request presenting HMAC headers is verified strictly (bad
 * kid / stale ts / bad signature → 401). When INTERNAL_AUTH_REQUIRE_HMAC=true
 * in production, the legacy static bearer is REFUSED on the guarded route
 * (bearer remains accepted only in non-prod or when the flag is off).
 */

import crypto from "node:crypto";

export const INTERNAL_HMAC_MAX_SKEW_SECONDS = 300;
export const HDR_KEY_ID = "x-internal-key-id";
export const HDR_TS = "x-internal-ts";
export const HDR_SIGNATURE = "x-internal-signature";

export interface InternalHmacKeyring {
  /** kid → secret bytes. */
  keys: Record<string, string>;
  /** kid used for signing outbound requests. */
  activeKid: string | null;
}

/** Parse the configured keyring from env. Empty when unconfigured. */
export function internalHmacKeyring(env: NodeJS.ProcessEnv = process.env): InternalHmacKeyring {
  const keys: Record<string, string> = {};
  const raw = (env.INTERNAL_HMAC_KEYS ?? "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [kid, secret] of Object.entries(parsed)) {
        if (typeof secret === "string" && secret.length >= 16) keys[kid] = secret;
      }
    } catch {
      // malformed JSON — fail closed (empty keyring)
    }
  }
  const legacy = (env.INTERNAL_HMAC_SECRET ?? "").trim();
  if (legacy && legacy.length >= 16) {
    const kid = (env.INTERNAL_HMAC_KEY_ID ?? "").trim() || "v1";
    if (!keys[kid]) keys[kid] = legacy;
  }
  const activeKid = (env.INTERNAL_HMAC_KEY_ID ?? "").trim() || Object.keys(keys)[0] || null;
  return { keys, activeKid: activeKid && keys[activeKid] ? activeKid : null };
}

export function hmacConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(internalHmacKeyring(env).keys).length > 0;
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function signPayload(secret: string, ts: number, method: string, path: string, rawBody: string | Buffer): string {
  const bodyHash = sha256Hex(rawBody);
  return crypto.createHmac("sha256", secret)
    .update(`${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}`)
    .digest("hex");
}

/**
 * Sign an outbound internal request. Returns the three headers, or null when
 * HMAC is not configured (caller then falls back to the legacy bearer).
 */
export function signInternalRequest(opts: {
  method: string;
  path: string;
  body?: string | Buffer;
  now?: number; // unix seconds (test hook)
  env?: NodeJS.ProcessEnv;
}): Record<string, string> | null {
  const ring = internalHmacKeyring(opts.env);
  if (!ring.activeKid) return null;
  const ts = opts.now ?? Math.floor(Date.now() / 1000);
  const secret = ring.keys[ring.activeKid];
  return {
    [HDR_KEY_ID]: ring.activeKid,
    [HDR_TS]: String(ts),
    [HDR_SIGNATURE]: signPayload(secret, ts, opts.method, opts.path, opts.body ?? ""),
  };
}

export type InternalHmacVerdict =
  | { ok: true; kid: string }
  | { ok: false; error: "missing-headers" | "unknown-kid" | "stale-ts" | "bad-signature" | "not-configured" };

/**
 * Verify an inbound internal request's HMAC headers. `rawBody` must be the
 * exact bytes that were signed (express.json consumers: JSON.stringify of
 * the parsed body is acceptable when the signer signs the canonical JSON —
 * our signers do).
 */
export function verifyInternalRequest(opts: {
  method: string;
  path: string;
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): InternalHmacVerdict {
  const ring = internalHmacKeyring(opts.env);
  const get = (name: string): string => {
    const v = opts.headers[name];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };
  const kid = get(HDR_KEY_ID).trim();
  const tsRaw = get(HDR_TS).trim();
  const signature = get(HDR_SIGNATURE).trim();
  if (!kid || !tsRaw || !signature) return { ok: false, error: "missing-headers" };
  if (Object.keys(ring.keys).length === 0) return { ok: false, error: "not-configured" };
  const secret = ring.keys[kid];
  if (!secret) return { ok: false, error: "unknown-kid" };
  const ts = Number(tsRaw);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > INTERNAL_HMAC_MAX_SKEW_SECONDS) {
    return { ok: false, error: "stale-ts" };
  }
  const expected = signPayload(secret, ts, opts.method, opts.path, opts.rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "bad-signature" };
  }
  return { ok: true, kid };
}

/** True when the request carries the HMAC header trio (any values). */
export function hasInternalHmacHeaders(headers: Record<string, unknown>): boolean {
  return Boolean(headers[HDR_KEY_ID] || headers[HDR_TS] || headers[HDR_SIGNATURE]);
}

/**
 * Production fail-closed knob: INTERNAL_AUTH_REQUIRE_HMAC=true refuses the
 * legacy static bearer on guarded sensitive routes.
 */
export function hmacRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.INTERNAL_AUTH_REQUIRE_HMAC ?? "").trim().toLowerCase() === "true";
}
// === END W46 platform-p2 (PLT-15) ===
