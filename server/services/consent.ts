/**
 * consent.ts — NDPR-style messaging consent capture and lookup.
 *
 * First-ever inbound WhatsApp message from a phone (no consents row for the
 * tenant) triggers an opt-in prompt; the YES/NO reply is persisted to the
 * consents table (channel "whatsapp"). Broadcast/notification paths must gate
 * proactive sends on hasConsent(tenantId, phone).
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { consents } from "../../drizzle/schema";
// === W47 crosscutting (ONB-I18N-1): locale packs for the consent copy. ===
import { tr } from "./i18n";

export const CONSENT_CHANNEL_WHATSAPP = "whatsapp";

export const CONSENT_PROMPT =
  "Before we continue: we'd like to send you order updates and offers on WhatsApp. " +
  "Under NDPR this needs your consent. Reply YES to receive order updates, or NO to opt out. " +
  "You can change this anytime by messaging us.";

export const CONSENT_GRANTED_REPLY =
  "Thank you! You've opted in to order updates on WhatsApp.";

export const CONSENT_DENIED_REPLY =
  "Understood — you've opted out of proactive order updates. " +
  "You can still message us anytime, and reply YES later to opt back in.";

// === W47 crosscutting (ONB-I18N-1) ===
// Locale-aware consent copy: the consent prompt is the NDPR legal artifact —
// an English-only prompt to a Hausa/Swahili speaker is arguably not informed
// consent. These delegate to the i18n locale packs (en/fr/ha/yo/ig/sw/am).
export function consentPromptFor(locale?: string | null): string {
  return tr(locale, "consentPrompt") || CONSENT_PROMPT;
}
export function consentGrantedFor(locale?: string | null): string {
  return tr(locale, "consentGranted") || CONSENT_GRANTED_REPLY;
}
export function consentDeniedFor(locale?: string | null): string {
  return tr(locale, "consentDenied") || CONSENT_DENIED_REPLY;
}
// === END W47 crosscutting ===

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Parse a YES/NO consent reply (en/fr/ha/yo/ig). Returns true/false, or null when ambiguous. */
export function parseConsentReply(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (/^(yes|y|yeah|yep|ok|okay|sure|agree|accept|oui|eh|bẹẹni|beeni|bẹẹ ni|ee|eef|iyo)$/.test(t)) return true;
  if (/^(no|n|nope|stop|decline|reject|opt[\s-]?out|non|a'a|rara|mba)$/.test(t)) return false;
  return null;
}

/** Fetch the consent row for a (tenant, phone, channel) triple. */
export async function getConsent(
  db: Db,
  tenantId: string,
  phone: string,
  channel: string = CONSENT_CHANNEL_WHATSAPP,
) {
  const [row] = await db
    .select()
    .from(consents)
    .where(and(
      eq(consents.tenantId, tenantId),
      eq(consents.phone, phone),
      eq(consents.channel, channel),
    ))
    .limit(1)
    .catch(() => [] as any[]);
  return row ?? null;
}

/**
 * Persist a consent decision. Inserts a fresh row when none exists, otherwise
 * updates the existing one (re-consent / opt-out flip).
 *
 * === W46 privacy-consent (TEN-16): proof-of-consent versioning ===========
 * Every GRANT stamps the policy/template version the buyer agreed to plus
 * the inbound evidence id (WhatsApp wamid) when known, so a DSAR/regulator
 * can be shown exactly what was agreed and when. A RE-GRANT after a prior
 * withdrawal is counted (regrantCount/lastRegrantAt) and rate-limited: more
 * than MAX_REGRANTS_PER_DAY re-grants within 24h is refused (the withdrawal
 * stands) and logged — silent re-grant abuse is no longer possible.
 */
// === W47 buyer (ONB-B-5): real consent policy registry ====================
// Prompt text is VERSIONED: a major-version bump of the prompt copy registers
// a new entry here (never reuse a version string for different copy), which
// makes re-consent detection possible (row.policyVersion !== current).
export interface ConsentPolicyEntry {
  version: string;
  /** SHA-free human description of the copy change for audit. */
  summary: string;
  effectiveFrom: string; // ISO date
}
export const CONSENT_POLICY_REGISTRY: ConsentPolicyEntry[] = [
  { version: "ndpr-consent-v1", summary: "Initial NDPR opt-in prompt (order updates + offers).", effectiveFrom: "2025-01-01" },
  { version: "ndpr-consent-v2", summary: "W47: prompt covers order updates, offers AND media/AI-scan processing; first-contact NO keeps limited service.", effectiveFrom: "2026-01-01" },
];
export const CONSENT_POLICY_VERSION = CONSENT_POLICY_REGISTRY[CONSENT_POLICY_REGISTRY.length - 1].version;
// === END W47 buyer ===
export const CONSENT_PROOF_TEMPLATE = "consent_optin_prompt";
export const MAX_REGRANTS_PER_DAY = 3;
const REGRANT_WINDOW_MS = 24 * 3600_000;

export class ConsentRegrantRateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentRegrantRateLimited";
  }
}

export async function recordConsent(
  db: Db,
  opts: {
    tenantId: string;
    phone: string;
    granted: boolean;
    channel?: string;
    customerId?: string | null;
    /** W46 TEN-16: proof-of-consent evidence (all optional, additive). */
    policyVersion?: string | null;
    proofTemplate?: string | null;
    /** WhatsApp message id of the buyer's affirmative reply. */
    proofWamid?: string | null;
  },
): Promise<void> {
  const channel = opts.channel ?? CONSENT_CHANNEL_WHATSAPP;
  let existing = await getConsent(db, opts.tenantId, opts.phone, channel);
  const now = new Date();
  // W46 TEN-16: re-grant abuse guard — a grant on a previously WITHDRAWN row.
  // === W47 crosscutting (ONB-TOCTOU-1): the counter bump is now an ATOMIC
  // guarded UPDATE (regrant_count incremented inside the WHERE-guarded
  // statement) — concurrent re-grants can no longer both read count<MAX and
  // both write; the DB decides the winner. ===
  if (opts.granted && existing?.withdrawnAt) {
    const windowStart = new Date(now.getTime() - REGRANT_WINDOW_MS);
    const updateSet = {
      granted: true,
      grantedAt: now,
      withdrawnAt: null,
      source: "whatsapp_reply",
      updatedAt: now,
      policyVersion: opts.policyVersion ?? CONSENT_POLICY_VERSION,
      proofTemplate: opts.proofTemplate ?? CONSENT_PROOF_TEMPLATE,
      proofWamid: opts.proofWamid ?? null,
      regrantCount: sql`${consents.regrantCount} + 1`,
      lastRegrantAt: now,
    };
    const stmt = db
      .update(consents)
      .set(updateSet)
      .where(and(
        eq(consents.id, existing.id),
        // Guard: either the last re-grant aged out of the 24h window (counter
        // logically resets via the ELSE branch semantics below), or the count
        // is still under the cap. Concurrent losers update 0 rows.
        sql`(${consents.lastRegrantAt} IS NULL OR ${consents.lastRegrantAt} <= ${windowStart.toISOString()} OR ${consents.regrantCount} < ${MAX_REGRANTS_PER_DAY})`,
      ));
    if (typeof stmt.returning === "function") {
      // Real driver: atomic guarded UPDATE, affected rows tell the verdict.
      const updated = await stmt.returning({ id: consents.id, regrantCount: consents.regrantCount });
      if (updated.length === 0) {
        console.warn(
          `[consent] TEN-16 re-grant rate-limited (atomic guard): tenant=${opts.tenantId} phone=${opts.phone.slice(-4).padStart(opts.phone.length, "*")} — withdrawal stands`,
        );
        throw new ConsentRegrantRateLimited(
          "Consent was withdrawn recently; too many re-grants within 24 hours. Please try again later.",
        );
      }
      console.info(
        `[consent] TEN-16 re-grant after withdrawal: tenant=${opts.tenantId} phone=***${opts.phone.slice(-4)} regrantCount=${updated[0].regrantCount}`,
      );
      return;
    }
    // Test doubles without .returning(): keep the pre-W47 read-guarded
    // semantics (the unique index + atomic path cover real races in prod).
    const recentRegrant =
      existing.lastRegrantAt && new Date(existing.lastRegrantAt as any) > windowStart;
    const count = Number(existing.regrantCount ?? 0);
    if (recentRegrant && count >= MAX_REGRANTS_PER_DAY) {
      throw new ConsentRegrantRateLimited(
        "Consent was withdrawn recently; too many re-grants within 24 hours. Please try again later.",
      );
    }
    await stmt;
    return;
  }
  // === END W47 crosscutting ===
  if (existing) {
    await db
      .update(consents)
      .set({
        granted: opts.granted,
        updatedAt: now,
        // W17 F8: a grant stamps grantedAt + clears any prior withdrawal;
        // a denial is left to recordWithdrawal (which sets withdrawnAt).
        // W46 TEN-16: grants also stamp the proof-of-consent version/evidence.
        ...(opts.granted ? {
          grantedAt: now,
          withdrawnAt: null,
          source: "whatsapp_reply",
          policyVersion: opts.policyVersion ?? CONSENT_POLICY_VERSION,
          proofTemplate: opts.proofTemplate ?? CONSENT_PROOF_TEMPLATE,
          proofWamid: opts.proofWamid ?? null,
        } : {}),
      })
      .where(eq(consents.id, existing.id));
    return;
  }
  // === W47 crosscutting (ONB-TOCTOU-1): unique (tenant,phone,channel)
  // backstop (mig 0169) — concurrent first-contact grants conflict; retry as
  // the update path on the winner's row. ===
  try {
    await db.insert(consents).values({
      tenantId: opts.tenantId,
      phone: opts.phone,
      customerId: opts.customerId ?? null,
      channel,
      granted: opts.granted,
      source: "whatsapp_reply",
      ...(opts.granted ? {
        grantedAt: now,
        policyVersion: opts.policyVersion ?? CONSENT_POLICY_VERSION,
        proofTemplate: opts.proofTemplate ?? CONSENT_PROOF_TEMPLATE,
        proofWamid: opts.proofWamid ?? null,
      } : {}),
    });
  } catch (e: any) {
    if (!/consents_tenant_phone_channel_uniq|duplicate key/i.test(`${e?.message ?? ""} ${e?.cause?.message ?? ""}`)) throw e;
    existing = await getConsent(db, opts.tenantId, opts.phone, channel);
    if (existing) {
      await db
        .update(consents)
        .set({
          granted: opts.granted,
          updatedAt: new Date(),
          ...(opts.granted ? {
            grantedAt: new Date(),
            withdrawnAt: null,
            source: "whatsapp_reply",
            policyVersion: opts.policyVersion ?? CONSENT_POLICY_VERSION,
            proofTemplate: opts.proofTemplate ?? CONSENT_PROOF_TEMPLATE,
            proofWamid: opts.proofWamid ?? null,
          } : {}),
        })
        .where(eq(consents.id, existing.id));
    }
  }
  // === END W47 crosscutting ===
}

/**
 * Broadcast gate (contract with the broadcast worker):
 *   WHERE tenant_id=? AND phone=? AND channel='whatsapp' AND granted=true
 * Fails CLOSED (false) when the DB is unavailable — no consent, no broadcast.
 */
export async function hasConsent(tenantId: string, phone: string): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn("[consent] DB unavailable — treating hasConsent as false (fail closed)");
    return false;
  }
  const row = await getConsent(db, tenantId, phone, CONSENT_CHANNEL_WHATSAPP);
  // === W47 buyer (ONB-B-13): align with hasChannelConsent / the broadcast
  // audience filter — a withdrawn row NEVER counts as consent, even if an
  // ops repair left granted=true on a withdrawn row. ===
  return row?.granted === true && !row.withdrawnAt;
}

// === W37 telegram (Coder B): channel-aware consent seam ===
// The WhatsApp helpers above are untouched. Telegram implements STOP
// correctly from day one: /stop (or the text "STOP") revokes consent for
// the telegram channel identity (keyed by the session key
// `telegram:<chat_id>`, never a raw phone), and /start records opt-in.

export const CONSENT_CHANNEL_TELEGRAM = "telegram";

/** Channel-generic consent check (WhatsApp callers keep using hasConsent). */
export async function hasChannelConsent(
  tenantId: string,
  sessionKey: string,
  channel: string,
): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn("[consent] DB unavailable — treating hasChannelConsent as false (fail closed)");
    return false;
  }
  const row = await getConsent(db, tenantId, sessionKey, channel);
  return row?.granted === true && !row.withdrawnAt;
}

/** Fetch the raw consent row for a channel identity (null when none). */
export async function getChannelConsent(
  db: Db,
  tenantId: string,
  sessionKey: string,
  channel: string,
) {
  return getConsent(db, tenantId, sessionKey, channel);
}

/** Record an explicit opt-in for a channel identity (e.g. Telegram /start). */
export async function recordChannelOptIn(
  db: Db,
  opts: { tenantId: string; sessionKey: string; channel: string; source?: string },
): Promise<void> {
  await recordConsent(db, {
    tenantId: opts.tenantId,
    phone: opts.sessionKey,
    granted: true,
    channel: opts.channel,
  });
  // recordConsent stamps grantedAt + clears withdrawnAt on grant; nothing
  // further needed here. (source column keeps its existing vocabulary.)
}

/**
 * === W47 buyer (ONB-B-4): first-contact denial for a channel identity ===
 * Mirrors the WhatsApp J1 contract exactly: a first-contact NO records a
 * granted=false row WITHOUT withdrawnAt, so the buyer keeps LIMITED service
 * (can still chat; no proactive sends). withdrawnAt is reserved for explicit
 * STOP-style revocation (recordChannelRevocation).
 */
export async function recordChannelDenial(
  db: Db,
  opts: { tenantId: string; sessionKey: string; channel: string },
): Promise<void> {
  const existing = await getConsent(db, opts.tenantId, opts.sessionKey, opts.channel);
  if (existing) {
    if (existing.granted !== false || existing.withdrawnAt) {
      await db
        .update(consents)
        .set({ granted: false, withdrawnAt: null, updatedAt: new Date() })
        .where(eq(consents.id, existing.id));
    }
    return;
  }
  await db.insert(consents).values({
    tenantId: opts.tenantId,
    phone: opts.sessionKey,
    channel: opts.channel,
    granted: false,
    source: "chat_first_contact_no",
  });
}

/**
 * Revoke consent for a channel identity (Telegram /stop or "STOP"). Sets
 * granted=false + withdrawnAt so proactive-send gates (which check granted)
 * close immediately, and the withdrawal is auditable. Never throws.
 */
export async function recordChannelRevocation(
  db: Db,
  opts: { tenantId: string; sessionKey: string; channel: string },
): Promise<void> {
  const existing = await getConsent(db, opts.tenantId, opts.sessionKey, opts.channel);
  const now = new Date();
  try {
    if (existing) {
      await db
        .update(consents)
        .set({ granted: false, withdrawnAt: now, updatedAt: now })
        .where(eq(consents.id, existing.id));
      return;
    }
    // No prior row: persist an explicit denial so the revocation survives
    // even when the user never opted in (STOP before /start).
    await db.insert(consents).values({
      tenantId: opts.tenantId,
      phone: opts.sessionKey,
      channel: opts.channel,
      granted: false,
      source: "telegram_stop",
      withdrawnAt: now,
    });
  } catch (e: any) {
    console.warn("[consent] recordChannelRevocation failed:", e?.message);
  }
}
// === END W37 telegram ===

// === W47 crosscutting (ONB-ID-3): recycled-number protection ============
/**
 * Expire a DORMANT identity's consent state: after >ONB_DORMANT_DAYS of
 * silence the current holder of a recycled number must NOT inherit the prior
 * owner's consent/cart/session. Deletes the consent row (so the first-contact
 * consent prompt re-fires) and writes an audit row. Never throws.
 */
export async function resetDormantIdentity(
  db: Db,
  opts: { tenantId: string; phone: string; channel?: string; lastActivityAt: Date },
): Promise<void> {
  const channel = opts.channel ?? CONSENT_CHANNEL_WHATSAPP;
  try {
    const existing = await getConsent(db, opts.tenantId, opts.phone, channel);
    if (existing) {
      await db.delete(consents).where(eq(consents.id, existing.id));
    }
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      actorId: "system:dormancy",
      actorRole: "system",
      action: "consent.dormant_identity_reset",
      entityType: "consents",
      entityId: existing?.id ?? `${opts.tenantId}:${opts.phone}:${channel}`,
      tenantId: opts.tenantId,
      summary:
        `dormant identity reset for ${channel} identity ***${opts.phone.slice(-4)} ` +
        `(last activity ${opts.lastActivityAt.toISOString()}) — consent re-prompt required`,
      before: existing ? { granted: existing.granted, withdrawnAt: existing.withdrawnAt } : null,
    });
  } catch (e: any) {
    console.warn("[consent] resetDormantIdentity failed:", e?.message);
  }
}
// === END W47 crosscutting ===
