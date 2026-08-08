/**
 * Buyer tracking tokens.
 *
 * A tracking token is `<orderId>.<hmac>` where the HMAC is
 * HMAC-SHA256(secret, orderId), base64url, truncated to 24 chars. The token
 * is stateless — nothing is stored — so it round-trips purely by
 * recomputation. The secret is TRACKING_SECRET, falling back to JWT_SECRET
 * (already asserted non-default in production by server/_core/env.ts).
 *
 * The token grants read-only access to a minimal, PII-scrubbed order status
 * view (see routers/tracking.ts) — it is a bearer capability link shared with
 * the buyer over WhatsApp, equivalent to a carrier tracking URL.
 */

import crypto from "crypto";

const SIG_LENGTH = 24;

function trackingSecret(): string {
  return process.env.TRACKING_SECRET || process.env.JWT_SECRET || "dev-only-insecure-tracking-secret";
}

function signatureFor(orderId: string): string {
  return crypto
    .createHmac("sha256", trackingSecret())
    .update(orderId)
    .digest("base64url")
    .slice(0, SIG_LENGTH);
}

export function generateTrackingToken(orderId: string): string {
  return `${orderId}.${signatureFor(orderId)}`;
}

/** Returns the orderId when the token is valid, null otherwise. */
export function verifyTrackingToken(token: string): string | null {
  if (typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const orderId = token.slice(0, idx);
  const presented = Buffer.from(token.slice(idx + 1), "utf8");
  const expected = Buffer.from(signatureFor(orderId), "utf8");
  if (presented.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(presented, expected)) return null;
  return orderId;
}

/** Absolute tracking URL for an order, based on APP_URL (never hardcoded). */
export function trackingUrlFor(orderId: string): string {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/track/${generateTrackingToken(orderId)}`;
}
