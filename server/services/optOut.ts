/**
 * === W40 MSG-1: STOP honored mid-conversation ===
 * optOut.ts — always-on opt-out interceptor shared by the WhatsApp
 * conversational pipeline (useCases.ts) and the Telegram inbound pipeline
 * (telegramInbound.ts parity check).
 *
 * Doctrine (Meta WhatsApp Business policy + NDPR/GDPR):
 *   1. A STOP keyword revokes consent IMMEDIATELY — before any menu/NLP
 *      reply generation — even mid-conversation (previously STOP only
 *      worked at the first-contact consent gate; after opt-in it fell
 *      through to the NLP pipeline and was never revoked — W36 MSG-1).
 *   2. The user gets ONE suppressed-reply confirmation (Meta requires the
 *      opt-out to be acknowledged; marketing must stop after that).
 *   3. Every subsequent inbound from a revoked identity is BLOCKED (bot
 *      stays silent) until the user explicitly re-opts-in with a YES-style
 *      keyword, which re-grants consent through the same parseConsentReply
 *      classifier the consent gate uses.
 *
 * Reuse note (spec): parseConsentReply is reused for the RE-SUBSCRIBE side
 * (decision === true). It is deliberately NOT the revocation trigger: it
 * classifies bare "no"/"n"/"rara"/"mba" as denials, which are ordinary
 * mid-conversation answers ("no" to "add drinks?") and must not nuke
 * consent. Revocation uses the Meta canonical STOP keyword set below.
 *
 * TEN-16 adjacency (W36 cross-ref): every revocation writes an audit_logs
 * evidence row (actor = the phone identity, action = consent.withdrawn) so
 * the withdrawal is provable, not just a flag flip.
 */

import { writeAuditLog } from "../routers/audit";

/**
 * Meta canonical opt-out keywords (single-word, exact match after trim).
 * Bare "cancel" is intentionally excluded: it collides with order-cancel
 * flows in the NLP pipeline. Multi-word "opt out" / "opt-out" included.
 */
export const OPT_OUT_PATTERN =
  /^\s*(stop|stopall|unsubscribe|opt[\s-]?out|quit|end)\s*$/i;

/** True when the inbound text is a canonical STOP/opt-out keyword. */
export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_PATTERN.test(text ?? "");
}

/**
 * One-time suppressed-reply confirmation sent right after a STOP revocation
 * (Meta policy: acknowledge the opt-out, then go silent).
 */
export const WA_STOP_CONFIRMATION =
  "You've been unsubscribed and will no longer receive WhatsApp messages from us. " +
  "Reply YES anytime to resubscribe.";

/** Telegram equivalent (same policy, channel-appropriate wording). */
export const TG_STOPPED_SILENCE_NOTE =
  "You've been unsubscribed and will no longer receive Telegram messages from us. " +
  "Reply YES or /start anytime to resubscribe.";

/**
 * True when an existing consent row represents an explicit withdrawal
 * (recordChannelRevocation stamps withdrawnAt). A first-contact NO
 * (granted=false, no withdrawnAt) is NOT a withdrawal — those users may
 * still chat (J1 contract: "opted out, can still chat"); only proactive
 * sends are gated for them.
 */
export function wasRevoked(consentRow: { withdrawnAt?: Date | string | null } | null | undefined): boolean {
  return !!consentRow?.withdrawnAt;
}

/**
 * Persist the TEN-16-class evidence row for a consent withdrawal. Never
 * throws (audit must not block the revocation itself).
 */
export async function auditConsentWithdrawal(opts: {
  tenantId: string;
  sessionKey: string;
  channel: string;
}): Promise<void> {
  await writeAuditLog({
    actorId: opts.sessionKey,
    actorRole: "customer",
    action: "consent.withdrawn",
    entityType: "consent",
    entityId: `${opts.tenantId}:${opts.channel}:${opts.sessionKey}`.slice(0, 128),
    tenantId: opts.tenantId,
    summary: `Consent withdrawn via ${opts.channel} STOP keyword (mid-conversation opt-out honored, bot silenced until explicit re-opt-in).`,
  });
}
