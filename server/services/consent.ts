/**
 * consent.ts — NDPR-style messaging consent capture and lookup.
 *
 * First-ever inbound WhatsApp message from a phone (no consents row for the
 * tenant) triggers an opt-in prompt; the YES/NO reply is persisted to the
 * consents table (channel "whatsapp"). Broadcast/notification paths must gate
 * proactive sends on hasConsent(tenantId, phone).
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { consents } from "../../drizzle/schema";

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
 */
export async function recordConsent(
  db: Db,
  opts: {
    tenantId: string;
    phone: string;
    granted: boolean;
    channel?: string;
    customerId?: string | null;
  },
): Promise<void> {
  const channel = opts.channel ?? CONSENT_CHANNEL_WHATSAPP;
  const existing = await getConsent(db, opts.tenantId, opts.phone, channel);
  const now = new Date();
  if (existing) {
    await db
      .update(consents)
      .set({
        granted: opts.granted,
        updatedAt: now,
        // W17 F8: a grant stamps grantedAt + clears any prior withdrawal;
        // a denial is left to recordWithdrawal (which sets withdrawnAt).
        ...(opts.granted ? { grantedAt: now, withdrawnAt: null, source: "whatsapp_reply" } : {}),
      })
      .where(eq(consents.id, existing.id));
    return;
  }
  await db.insert(consents).values({
    tenantId: opts.tenantId,
    phone: opts.phone,
    customerId: opts.customerId ?? null,
    channel,
    granted: opts.granted,
    source: "whatsapp_reply",
    ...(opts.granted ? { grantedAt: now } : {}),
  });
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
  return row?.granted === true;
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
