/**
 * === W37 telegram (Coder B) ===
 * channelIdentity.ts — channel-scoped customer identity resolution.
 *
 * Doctrine: WhatsApp behavior is byte-equivalent — for channel "whatsapp"
 * (or an absent channel) the session key is the E.164 phone number exactly
 * as today. Telegram identities are keyed `telegram:<chat_id>` wherever
 * waPhoneNumber keys sessions (nlp_sessions, consents, carts, ...), so a
 * Telegram conversation NEVER collides with the WhatsApp identity of the
 * same phone.
 *
 * Phone linkage for Telegram happens ONLY via an explicit contact-share
 * (telegramInbound verifies contact.user_id == from.id before calling
 * bindTelegramPhone) — never inferred.
 */

import { and, eq } from "drizzle-orm";
import type { getDb } from "../db";
import { telegramIdentities } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const CHANNEL_WHATSAPP = "whatsapp";
export const CHANNEL_TELEGRAM = "telegram";

export type Channel = string;

/** Telegram session keys are namespaced so they can never collide with an E.164 phone. */
export const TELEGRAM_SESSION_PREFIX = "telegram:";

/**
 * Normalize a channel-scoped id into the session key used everywhere
 * waPhoneNumber keys sessions today.
 *   - whatsapp (default): the id unchanged (E.164 as today — WA byte-equivalent).
 *   - telegram: `telegram:<chat_id>`.
 */
export function sessionKeyFor(channel: Channel | null | undefined, id: string): string {
  if (!channel || channel === CHANNEL_WHATSAPP) return id;
  if (channel === CHANNEL_TELEGRAM) {
    const raw = id.startsWith(TELEGRAM_SESSION_PREFIX) ? id.slice(TELEGRAM_SESSION_PREFIX.length) : id;
    return `${TELEGRAM_SESSION_PREFIX}${raw}`;
  }
  // Unknown future channels: namespace defensively, never silently collide
  // with WhatsApp phone keys.
  return `${channel}:${id}`;
}

/** Inverse of sessionKeyFor for telegram keys (identity helpers; WA ids pass through). */
export function channelFromSessionKey(key: string): { channel: Channel; id: string } {
  if (key.startsWith(TELEGRAM_SESSION_PREFIX)) {
    return { channel: CHANNEL_TELEGRAM, id: key.slice(TELEGRAM_SESSION_PREFIX.length) };
  }
  return { channel: CHANNEL_WHATSAPP, id: key };
}

export interface ResolvedIdentity {
  tenantId: string;
  channel: Channel;
  /** Raw channel-scoped id (chat_id for telegram, E.164 phone for whatsapp). */
  channelScopedId: string;
  /** Canonical session key (`telegram:<chat_id>` / E.164). */
  sessionKey: string;
  /** Linked E.164 phone when an explicit contact-share bound one, else null. */
  phoneE164: string | null;
  username?: string | null;
}

/**
 * Resolve the canonical customer identity for an inbound event. For WhatsApp
 * this is a pure pass-through (no DB read — the WA hot path is untouched).
 * For Telegram it reads/creates the telegram_identities row so the linked
 * phone (when explicitly shared) travels with the session.
 */
export async function resolveIdentity(
  db: Db,
  tenantId: string,
  channel: Channel,
  channelScopedId: string,
): Promise<ResolvedIdentity> {
  if (!channel || channel === CHANNEL_WHATSAPP) {
    return { tenantId, channel: CHANNEL_WHATSAPP, channelScopedId, sessionKey: channelScopedId, phoneE164: channelScopedId };
  }
  const sessionKey = sessionKeyFor(channel, channelScopedId);
  if (channel !== CHANNEL_TELEGRAM) {
    return { tenantId, channel, channelScopedId, sessionKey, phoneE164: null };
  }
  const [row] = await db
    .select()
    .from(telegramIdentities)
    .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.chatId, channelScopedId)))
    .limit(1)
    .catch(() => [] as any[]);
  return {
    tenantId,
    channel,
    channelScopedId,
    sessionKey,
    phoneE164: row?.phoneE164 ?? null,
    username: row?.username ?? null,
  };
}

/**
 * Bind a Telegram chat_id to an E.164 phone. Callers MUST have verified the
 * contact-share is self-shared (contact.user_id == from.id) — this function
 * trusts that check and records linked_via for audit. Upserts on
 * (tenant_id, chat_id).
 */
export async function bindTelegramPhone(
  db: Db,
  opts: {
    tenantId: string;
    chatId: string;
    phoneE164: string | null;
    username?: string | null;
    linkedVia: string;
  },
): Promise<void> {
  const now = new Date();
  const [existing] = await db
    .select()
    .from(telegramIdentities)
    .where(and(eq(telegramIdentities.tenantId, opts.tenantId), eq(telegramIdentities.chatId, opts.chatId)))
    .limit(1)
    .catch(() => [] as any[]);
  if (existing) {
    await db
      .update(telegramIdentities)
      .set({
        phoneE164: opts.phoneE164 ?? existing.phoneE164,
        username: opts.username ?? existing.username,
        linkedVia: opts.linkedVia,
        updatedAt: now,
      })
      .where(eq(telegramIdentities.id, existing.id));
    return;
  }
  await db.insert(telegramIdentities).values({
    tenantId: opts.tenantId,
    chatId: opts.chatId,
    phoneE164: opts.phoneE164,
    username: opts.username ?? null,
    linkedVia: opts.linkedVia,
    createdAt: now,
    updatedAt: now,
  });
}

/** Look up a telegram identity by linked phone (e.g. outbound routing by customer phone). */
export async function findTelegramIdentityByPhone(
  db: Db,
  tenantId: string,
  phoneE164: string,
): Promise<ResolvedIdentity | null> {
  const [row] = await db
    .select()
    .from(telegramIdentities)
    .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.phoneE164, phoneE164)))
    .limit(1)
    .catch(() => [] as any[]);
  if (!row) return null;
  return {
    tenantId,
    channel: CHANNEL_TELEGRAM,
    channelScopedId: row.chatId,
    sessionKey: sessionKeyFor(CHANNEL_TELEGRAM, row.chatId),
    phoneE164: row.phoneE164 ?? null,
    username: row.username ?? null,
  };
}
// === END W37 telegram ===
