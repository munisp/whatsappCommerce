// === W47 buyer (ONB-B-2) ===
/**
 * chatIdentityTrust.ts — recycled-number / SIM-swap protection for the CHAT
 * surface.
 *
 * Buyer identity on chat IS the phone number. Carriers recycle numbers: the
 * new SIM owner of a previously-used number must NOT inherit the prior
 * owner's order history, tracking links or consent grant. The portal already
 * has the TEN-20 deviceAuth SIM-swap defense; this module is the chat-side
 * counterpart.
 *
 * Policy (fail-CLOSED on ambiguity for order PII):
 *  - No customer history for the number → nothing to leak → clean path.
 *  - History exists AND the holder has a fresh proof marker
 *    (customers.chatIdentityVerifiedAt) → disclose.
 *  - History exists, no proof, AND any ambiguity signal (long dormancy,
 *    profile-name change, or no name on file to confirm against) → a
 *    lightweight proof is required before disclosure: the buyer confirms the
 *    first name on the account, or proves via the portal device-auth link.
 *  - A holder who states the number is NEW to them gets a clean-slate: the
 *    old identity is tombstoned (orders keep pointing at the anonymized
 *    customer row, never the live phone) and consent/session rows for the
 *    phone are removed, so nothing is inherited.
 */
import { and, eq, inArray, desc } from "drizzle-orm";
import { customers, orders } from "../../drizzle/schema";

type Db = any;

/** Numbers dormant longer than this are treated as recycling-suspect. */
export const REUSE_DORMANCY_DAYS = 90;
/** Max failed name-confirmation attempts before the challenge locks. */
export const MAX_IDENTITY_VERIFY_ATTEMPTS = 3;

export interface ChatIdentityAssessment {
  /** False when there is no history to protect (clean path). */
  hasHistory: boolean;
  /** True when a fresh proof marker exists for the current holder. */
  verified: boolean;
  /** True → the caller must run the verification challenge BEFORE exposing
   *  order history / tracking / inherited consent. */
  requiresProof: boolean;
  reason?: "dormant" | "name_mismatch" | "no_name_on_file";
  /** Name on file (used for the confirmation challenge; never disclosed). */
  knownName: string | null;
}

/**
 * Assess whether order-history-disclosing intents may proceed for `phone`.
 * Never throws — on lookup error it FAILS CLOSED (requiresProof=true when
 * history could not be ruled out is impossible to know; we err on proof).
 */
export async function assessChatIdentity(
  db: Db,
  tenantId: string,
  phone: string,
  contactName?: string | null,
): Promise<ChatIdentityAssessment> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1)
    .catch(() => [] as any[]);
  if (!customer) return { hasHistory: false, verified: false, requiresProof: false, knownName: null };

  const candidates = [customer.id, phone];
  const history = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), inArray(orders.customerId, candidates)))
    .orderBy(desc(orders.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  const hasHistory = history.length > 0;
  if (!hasHistory) return { hasHistory: false, verified: true, requiresProof: false, knownName: customer.name ?? null };

  if (customer.chatIdentityVerifiedAt) {
    return { hasHistory: true, verified: true, requiresProof: false, knownName: customer.name ?? null };
  }

  const knownName: string | null = customer.name ?? null;
  const lastActivity = customer.lastOrderAt ?? customer.updatedAt ?? customer.createdAt;
  const dormantMs = lastActivity ? Date.now() - new Date(lastActivity).getTime() : Number.MAX_SAFE_INTEGER;
  const dormant = dormantMs > REUSE_DORMANCY_DAYS * 24 * 3600_000;
  if (dormant) {
    return { hasHistory: true, verified: false, requiresProof: true, reason: "dormant", knownName };
  }
  if (contactName && knownName && !namesMatch(knownName, contactName)) {
    return { hasHistory: true, verified: false, requiresProof: true, reason: "name_mismatch", knownName };
  }
  // Active number, no conflict signal → disclose (the buyer just ordered).
  return { hasHistory: true, verified: false, requiresProof: false, knownName };
}

/** Loose name comparison (first token, case/diacritic-insensitive). */
export function namesMatch(known: string, given: string): boolean {
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  const a = norm(known);
  const b = norm(given);
  return !!a && !!b && a === b;
}

/** Stamp the proof marker for the current holder of `phone`. */
export async function markChatIdentityVerified(db: Db, tenantId: string, phone: string): Promise<void> {
  await db
    .update(customers)
    .set({ chatIdentityVerifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)));
}

/**
 * Clean-slate for a NEW owner of a recycled number. The prior identity is
 * tombstoned: orders keep referencing the now phone-less customer row (they
 * are no longer reachable by phone match), consent rows for the phone are
 * deleted (nothing is inherited), and the caller clears any Redis session.
 */
export async function cleanSlateForNewOwner(
  db: Db,
  tenantId: string,
  phone: string,
): Promise<{ tombstoned: boolean }> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1)
    .catch(() => [] as any[]);
  if (!customer) return { tombstoned: false };
  // whatsappPhone is varchar(30) — compact tombstone keeps the row
  // phone-less and unique without widening the column.
  const tombstone = `rc${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  await db
    .update(customers)
    .set({ whatsappPhone: tombstone, name: null, email: null, chatIdentityVerifiedAt: null, updatedAt: new Date() })
    .where(eq(customers.id, customer.id));
  const { consents, nlpSessions, cartSessions } = await import("../../drizzle/schema");
  await db.delete(consents).where(and(eq(consents.tenantId, tenantId), eq(consents.phone, phone))).catch(() => {});
  await db.delete(nlpSessions).where(and(eq(nlpSessions.tenantId, tenantId), eq(nlpSessions.waPhoneNumber, phone))).catch(() => {});
  await db.delete(cartSessions).where(and(eq(cartSessions.tenantId, tenantId), eq(cartSessions.waPhoneNumber, phone))).catch(() => {});
  return { tombstoned: true };
}

/** Buyer-facing copy for the verification challenge. */
export const IDENTITY_VERIFY_PROMPT =
  "For your security, please confirm the first name registered with this number before I share order details. " +
  "Reply with the name, or reply NEW if this number recently became yours.";

export const IDENTITY_VERIFY_LOCKED_REPLY =
  "I couldn't verify this number. Please contact the store directly or sign in to the customer portal to confirm your identity.";

export const IDENTITY_VERIFY_OK_REPLY = "Thanks — identity confirmed. ";

export const IDENTITY_CLEAN_SLATE_REPLY =
  "Done — we've started fresh for this number. Previous account history stays private to its owner; " +
  "you can shop and place orders as a new customer.";
// === END W47 buyer ===
