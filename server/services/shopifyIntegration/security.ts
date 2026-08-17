/**
 * shopifyIntegration/security.ts — webhook HMAC verification + secret
 * redaction for the Shopify app connector (roadmap F7).
 *
 * Shopify signs every webhook with HMAC-SHA256 of the RAW request body keyed
 * by the app client secret, delivered base64-encoded in the
 * X-Shopify-Hmac-Sha256 header. Verification here is timing-safe and fails
 * CLOSED: an unverified request must be rejected before any payload
 * processing.
 *
 * Replay tolerance: Shopify retries webhook delivery (up to ~48h) when the
 * receiver errors, and does not guarantee at-most-once delivery. HMAC
 * verification proves authenticity, NOT freshness — exactly-once semantics
 * are enforced downstream by the order bridge (dedupe by Shopify order id)
 * and by X-Shopify-Webhook-Id event claiming at the route layer.
 */
import crypto from "crypto";

/** Length-guarded constant-time comparison (timingSafeEqual throws on length mismatch). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify the X-Shopify-Hmac-Sha256 header against the raw body.
 * Never throws — any malformed input (missing header, bad base64) is simply
 * an invalid signature. Empty secret or empty signature always fails closed.
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  secret: string,
  headerValue: string | undefined | null,
): boolean {
  if (!secret || !headerValue) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  // Compare decoded bytes so base64 padding/whitespace tricks can't smuggle
  // a near-miss string past a naive string compare.
  const expectedBuf = Buffer.from(expected, "base64");
  const givenBuf = Buffer.from(headerValue.trim(), "base64");
  if (givenBuf.length === 0 || givenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

/** Sign an OAuth state nonce payload: hex HMAC-SHA256 of `payload`. */
export function signOAuthState(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** Timing-safe verification of a signed OAuth state payload. */
export function verifyOAuthState(payload: string, signature: string, secret: string): boolean {
  if (!payload || !signature || !secret) return false;
  return timingSafeEqualStr(signOAuthState(payload, secret), signature);
}

const SECRETISH_KEY = /token|secret|password|api[-_]?key|authorization/i;

/**
 * Redact secret-ish KEYS from an object before persisting to logs/audit.
 * (Same convention as compliance/bureau.ts redactPayload.)
 */
export function redactShopifyPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.length > 4000 ? value.slice(0, 4000) + "…" : value;
  if (Array.isArray(value)) return value.map((v) => redactShopifyPayload(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRETISH_KEY.test(k) ? "[redacted]" : redactShopifyPayload(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Strip any occurrence of a known secret VALUE (access token, app secret)
 * from free-form text before it reaches a log line.
 */
export function redactShopifySecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}
