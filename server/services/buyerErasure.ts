// === W47 buyer (ONB-B-8) ===
/**
 * buyerErasure.ts — phone-keyed buyer PII erasure shared by the portal
 * DSAR path (routers/privacy.ts) and the chat self-service path
 * ("DELETE MY DATA" on WhatsApp / Telegram).
 *
 * Scope: every phone-keyed buyer table that is NOT part of the documented
 * AML/tax residual set (orders, escrows, wallet ledger are retained; direct
 * identifiers are tombstoned on the customers row by the caller).
 * Erasing `phone` covers the WhatsApp identity; the linked Telegram
 * session key (`telegram:<chat_id>`) is erased too when an identity link
 * exists — a chat-only buyer is erased across BOTH channels.
 *
 * Re-onboarding after erasure is a clean slate: consents are deleted, so
 * the next inbound is a first-contact consent prompt; sessions/carts are
 * gone; age attestations are gone (re-attestation required).
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  ageAttestations,
  cartSessions,
  channelMessages,
  consents,
  nlpSessions,
  offlineMessageQueue,
  telegramIdentities,
  waWebhookEvents,
  whatsappCustomerReplies,
  whatsappMediaFiles,
} from "../../drizzle/schema";

type Db = any;

export interface BuyerErasureResult {
  phone: string;
  erasedKeys: string[];
  counts: Record<string, number>;
}

/** Count rows affected by a delete/update promise, never throwing. */
async function counted(p: Promise<any>): Promise<number> {
  try {
    const r: any = await p;
    return Number(r?.rowCount ?? r?.count ?? (Array.isArray(r) ? r.length : 0)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Erase all phone-keyed buyer PII for (tenantId, phone). `phone` is the
 * canonical E.164 identity; pass a `telegram:<chat_id>` session key to erase
 * a Telegram-only buyer. Returns per-table counts for the audit row.
 */
export async function erasePhoneKeyedBuyerData(
  db: Db,
  tenantId: string,
  phone: string,
): Promise<BuyerErasureResult> {
  const keys = new Set<string>([phone]);
  // A linked Telegram chat is the SAME buyer — erase that identity too.
  if (!phone.startsWith("telegram:")) {
    const links = await db
      .select({ chatId: telegramIdentities.chatId })
      .from(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.phoneE164, phone)))
      .catch(() => [] as any[]);
    for (const l of links as any[]) keys.add(`telegram:${l.chatId}`);
  } else {
    const chatId = phone.slice("telegram:".length);
    const [link] = await db
      .select({ phoneE164: telegramIdentities.phoneE164 })
      .from(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.chatId, chatId)))
      .limit(1)
      .catch(() => [] as any[]);
    if (link?.phoneE164) keys.add(link.phoneE164);
    await db
      .delete(telegramIdentities)
      .where(and(eq(telegramIdentities.tenantId, tenantId), eq(telegramIdentities.chatId, chatId)))
      .catch(() => {});
  }
  const keyList = Array.from(keys);
  const counts: Record<string, number> = {};

  // Consent grants MUST NOT survive erasure — a re-onboarded (or recycled)
  // number starts un-consented.
  counts.consents = await counted(
    db.delete(consents).where(and(eq(consents.tenantId, tenantId), inArray(consents.phone, keyList))),
  );
  counts.age_attestations = await counted(
    db.delete(ageAttestations).where(and(eq(ageAttestations.tenantId, tenantId), inArray(ageAttestations.phone, keyList))),
  );
  counts.nlp_sessions = await counted(
    db.delete(nlpSessions).where(and(eq(nlpSessions.tenantId, tenantId), inArray(nlpSessions.waPhoneNumber, keyList))),
  );
  counts.cart_sessions = await counted(
    db.delete(cartSessions).where(and(eq(cartSessions.tenantId, tenantId), inArray(cartSessions.waPhoneNumber, keyList))),
  );
  counts.channel_messages = await counted(
    db.delete(channelMessages).where(and(eq(channelMessages.tenantId, tenantId), inArray(channelMessages.fromAddress, keyList))),
  );
  counts.whatsapp_customer_replies = await counted(
    db.delete(whatsappCustomerReplies).where(and(eq(whatsappCustomerReplies.tenantId, tenantId), inArray(whatsappCustomerReplies.fromPhone, keyList))),
  );
  counts.offline_message_queue = await counted(
    db.delete(offlineMessageQueue).where(and(eq(offlineMessageQueue.tenantId, tenantId), inArray(offlineMessageQueue.waPhoneNumber, keyList))),
  );
  // Mirrored inbound media: delete the DB rows (object-storage blobs are
  // swept by the retention/tombstone sweep with the row gone).
  counts.whatsapp_media_files = await counted(
    db.delete(whatsappMediaFiles).where(and(eq(whatsappMediaFiles.tenantId, tenantId), inArray(whatsappMediaFiles.waPhoneNumber, keyList))),
  );
  // Webhook DLQ payloads contain the raw message body — scrub the payload,
  // keep the row for replay accounting.
  // Webhook DLQ payloads contain the raw message body — scrub the payload,
  // keep the row for replay accounting. (wa_webhook_events has no tenantId
  // column; the phone key itself is the scope.)
  counts.wa_webhook_events = await counted(
    db.update(waWebhookEvents)
      .set({ rawPayload: { erased: true }, waPhoneNumber: null, updatedAt: new Date() })
      .where(inArray(waWebhookEvents.waPhoneNumber, keyList)),
  );

  return { phone, erasedKeys: keyList, counts };
}
// === END W47 buyer ===
