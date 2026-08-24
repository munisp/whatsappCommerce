/**
 * W30 auth-gates — short-lived, audience-bound capability tokens.
 *
 * A capability token is an HS256 JWT (jwtSecret) with a `type` claim that
 * binds it to exactly ONE purpose and ONE resource. Used for:
 *   - "storage_cap"  : read access to a single /api/storage/* object key
 *                      (e.g. evidence links shared with a reviewer)
 *   - "buyer_confirm": authorizes buyerConfirm for one escrow — minted by the
 *                      server for the order's verified buyer channel
 *
 * Pure, injectable core (makeCapabilityTokens) so unit tests run without env.
 */
import jwt from "jsonwebtoken";
import { ENV } from "../_core/env";

export type CapabilityType = "storage_cap" | "buyer_confirm";

export interface CapabilityPayload {
  type: CapabilityType;
  /** Resource binding: storage object key or escrow id. */
  resource: string;
  /** Optional tenant binding for storage capabilities. */
  tenantId?: string;
  iat?: number;
  exp?: number;
}

export interface CapabilitySigner {
  sign(payload: CapabilityPayload, expiresInSeconds: number): string;
  verify(token: string, expectedType: CapabilityType, expectedResource: string): CapabilityPayload | null;
}

export function makeCapabilityTokens(secret: string): CapabilitySigner {
  return {
    sign(payload, expiresInSeconds) {
      return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: expiresInSeconds });
    },
    verify(token, expectedType, expectedResource) {
      try {
        const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as CapabilityPayload;
        if (payload.type !== expectedType) return null;
        if (payload.resource !== expectedResource) return null;
        return payload;
      } catch {
        return null;
      }
    },
  };
}

let _default: CapabilitySigner | null = null;
function defaultSigner(): CapabilitySigner {
  if (!_default) _default = makeCapabilityTokens(ENV.jwtSecret);
  return _default;
}

/** Mint a capability token (default 1h TTL, max 24h). */
export function mintCapabilityToken(
  payload: CapabilityPayload,
  expiresInSeconds = 3600,
): string {
  const ttl = Math.min(Math.max(60, expiresInSeconds), 24 * 3600);
  return defaultSigner().sign(payload, ttl);
}

/** Verify a capability token for an exact type+resource binding. */
export function verifyCapabilityToken(
  token: string,
  expectedType: CapabilityType,
  expectedResource: string,
): CapabilityPayload | null {
  return defaultSigner().verify(token, expectedType, expectedResource);
}
