/**
 * Rider links: one unguessable link per delivery order, sent by the shop to its own rider, that opens the
 * handover page (PIN + photo → delivered) with no account. Signed with its own purpose ("rider:"), so the
 * customer's tracking link (same secret, no purpose) can never be used to mark an order delivered.
 */
import crypto from "crypto";

const SIG_LENGTH = 32;

function secret(): string {
  return process.env.TRACKING_SECRET || process.env.JWT_SECRET || "dev-only-insecure-tracking-secret";
}

function signatureFor(orderId: string): string {
  return crypto.createHmac("sha256", secret()).update(`rider:${orderId}`).digest("base64url").slice(0, SIG_LENGTH);
}

export function riderToken(orderId: string): string {
  return `${orderId}.${signatureFor(orderId)}`;
}

/** The order id the token was issued for, or null when it isn't a valid rider token. */
export function verifyRiderToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const orderId = token.slice(0, idx);
  const presented = Buffer.from(token.slice(idx + 1), "utf8");
  const expected = Buffer.from(signatureFor(orderId), "utf8");
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return null;
  return orderId;
}

export function riderUrlFor(orderId: string): string {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/deliver/${riderToken(orderId)}`;
}
