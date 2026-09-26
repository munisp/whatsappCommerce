/**
 * === W37 telegram (Coder B) ===
 * telegramInbound.ts — Telegram webhook update normalization + processing.
 *
 * Route: POST /api/webhooks/telegram/:tenantId (registered in
 * server/_core/index.ts under the W37 banner, next to the WA webhook).
 * Tenant comes from the PATH and must have telegram enabled — we never
 * first-match tenants by bot token (TEN-3 class bug).
 *
 * Flow mirrors the WA webhook doctrine:
 *   - fail-closed, timing-safe X-Telegram-Bot-Api-Secret-Token validation
 *     against the per-tenant stored secret;
 *   - dedupe via processed_webhook_events with namespaced ids `tg:<update_id>`;
 *   - 200 ack first, all processing after the ack;
 *   - text/callback_query/contact/location/media normalized into the SAME
 *     canonical events the WA path produces (callback_query synthesizes the
 *     WA-equivalent interactive payload — id grammar `menu_<n>`, `order_*`,
 *     `catalog_ai:*` preserved verbatim in callback_data);
 *   - session identity `telegram:<chat_id>` via channelIdentity.sessionKeyFor;
 *   - /start = opt-in, /stop + "STOP" = revocation (consent.ts W37 seam) —
 *     Telegram implements STOP correctly from day one.
 *
 * Bot API calls needed on the inbound path (answerCallbackQuery,
 * editMessageReplyMarkup, getFile, sendMessage replies) are implemented here
 * as minimal plain-HTTPS helpers. Coder A owns the full outbound sender
 * (telegramSender.ts); when it lands these helpers can delegate to it —
 * documented honest choice, no new deps (global fetch).
 */

import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";
import { sessionKeyFor, bindTelegramPhone, CHANNEL_TELEGRAM } from "./channelIdentity";
import { renderInteractiveForTelegram, waMarkdownToTelegramHtml } from "./telegramRender";
import type { SendInteractiveInput } from "./waSender";
import {
  CONSENT_CHANNEL_TELEGRAM,
  getChannelConsent,
  hasChannelConsent,
  parseConsentReply,
  recordChannelOptIn,
  recordChannelRevocation,
} from "./consent";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;


/** Global kill switch — Telegram is DISABLED by default (fail-open). */
export function telegramEnabled(): boolean {
  return process.env.TELEGRAM_ENABLED === "true";
}

/** Media download pipeline gate (getFile + transcription/visual chain). */
export function telegramMediaEnabled(): boolean {
  return process.env.TELEGRAM_MEDIA_ENABLED === "true";
}

export interface TelegramTenantConfig {
  tenantId: string;
  enabled: boolean;
  botToken: string;
  botUsername: string;
  webhookSecret: string;
}

/**
 * Read the per-tenant telegram config from tenants.settings.telegram.
 * botToken + webhookSecret are stored encrypted (v1: envelope, same scheme
 * as whatsapp.accessToken); decryptSecret passes legacy plaintext through.
 * Returns null when the tenant does not exist.
 */
export async function getTelegramConfig(db: Db, tenantId: string): Promise<TelegramTenantConfig | null> {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  if (!t) return null;
  const settings = (t.settings ?? {}) as Record<string, any>;
  const tg = (settings.telegram ?? {}) as Record<string, any>;
  const rawToken = typeof tg.botToken === "string" ? tg.botToken : "";
  const rawSecret = typeof tg.webhookSecret === "string" ? tg.webhookSecret : "";
  let botToken = "";
  let webhookSecret = "";
  try {
    botToken = rawToken ? decryptSecret(rawToken) : "";
    webhookSecret = rawSecret ? decryptSecret(rawSecret) : "";
  } catch (e: any) {
    console.error("[telegram-inbound] secret decrypt failed (fail closed):", e?.message);
    return { tenantId, enabled: false, botToken: "", botUsername: "", webhookSecret: "" };
  }
  return {
    tenantId,
    enabled: tg.enabled === true,
    botToken,
    botUsername: typeof tg.botUsername === "string" ? tg.botUsername : "",
    webhookSecret,
  };
}

/** Timing-safe secret comparison (length-guarded; never throws). */
export function validateTelegramSecret(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Bot API calls (inbound side) ─────────────────────────────────────────────
// === W37 merger === these delegate to Coder A's telegramSender (single Bot
// API client: tenant credential resolution, retry/DLQ logging, simulation
// mode). The swap was mechanical — same settings.telegram credentials,
// same endpoints. B's standalone helpers were dropped at merge.

/** Minimal text reply (inbound path) via telegramSender. Never throws. */
export async function sendTelegramTextReply(tenantId: string, chatId: string | number, text: string) {
  const { sendTelegramText } = await import("./telegramSender");
  return sendTelegramText(tenantId, String(chatId), text, { parseMode: "HTML", disablePreview: true });
}

/** Ack a callback_query (Telegram requires an ack within ~10s). */
async function ackCallbackQuery(tenantId: string, callbackQueryId: string) {
  const { answerCallbackQuery } = await import("./telegramSender");
  return answerCallbackQuery(tenantId, callbackQueryId);
}

/** Clear a message's inline keyboard after a tap (prevents double-tap). */
async function clearInlineKeyboard(tenantId: string, chatId: string | number, messageId: number) {
  const { editMessageReplyMarkup } = await import("./telegramSender");
  return editMessageReplyMarkup(tenantId, String(chatId), messageId, { inline_keyboard: [] });
}

/** Download a file via getFile → file endpoint. Null on failure. */
async function tgDownloadFile(tenantId: string, fileId: string): Promise<{ buffer: Buffer } | null> {
  try {
    const { downloadTelegramFile } = await import("./telegramSender");
    const buffer = await downloadTelegramFile(tenantId, fileId);
    return buffer?.length ? { buffer } : null;
  } catch {
    return null;
  }
}
// === END W37 merger ===

// ── Update normalization ─────────────────────────────────────────────────────

export type NormalizedTelegramEvent =
  | { kind: "text"; updateId: number; chatId: string; fromId: number; username: string | null; name: string; text: string }
  | { kind: "command"; updateId: number; chatId: string; fromId: number; username: string | null; name: string; command: "start" | "stop" }
  | {
      kind: "callback";
      updateId: number;
      chatId: string;
      fromId: number;
      username: string | null;
      name: string;
      callbackQueryId: string;
      messageId: number | null;
      /** WA-equivalent interactive payload — SAME shape WA button_reply produces. */
      interactive: { type: "interactive"; interactiveType: "button_reply"; id: string; title: string };
    }
  | {
      kind: "contact";
      updateId: number;
      chatId: string;
      fromId: number;
      username: string | null;
      name: string;
      contactUserId: number | null;
      phoneNumber: string;
      /** true ONLY when contact.user_id == from.id (self-shared). */
      selfShared: boolean;
    }
  | { kind: "location"; updateId: number; chatId: string; fromId: number; username: string | null; name: string; latitude: number; longitude: number }
  | {
      kind: "media";
      updateId: number;
      chatId: string;
      fromId: number;
      username: string | null;
      name: string;
      mediaType: "voice" | "photo" | "document" | "audio" | "video";
      fileId: string;
      mimeType: string | null;
      caption: string;
    };

function fromMeta(from: any): { fromId: number; username: string | null; name: string } {
  return {
    fromId: Number(from?.id ?? 0),
    username: typeof from?.username === "string" ? from.username : null,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "",
  };
}

/**
 * Normalize a raw Telegram update into the canonical event set. Returns null
 * for updates we deliberately ignore (edited messages, channel posts, service
 * messages without content we handle).
 */
export function normalizeUpdate(update: any): NormalizedTelegramEvent | null {
  const updateId: number = Number(update?.update_id ?? 0);
  if (!updateId) return null;

  // callback_query → WA-equivalent interactive button_reply (id = callback_data).
  const cq = update?.callback_query;
  if (cq) {
    const meta = fromMeta(cq.from);
    const data = typeof cq.data === "string" ? cq.data : "";
    if (!data || !meta.fromId) return null;
    return {
      kind: "callback",
      updateId,
      chatId: String(cq.message?.chat?.id ?? meta.fromId),
      ...meta,
      callbackQueryId: String(cq.id ?? ""),
      messageId: typeof cq.message?.message_id === "number" ? cq.message.message_id : null,
      interactive: { type: "interactive", interactiveType: "button_reply", id: data, title: data },
    };
  }

  const msg = update?.message;
  if (!msg) return null;
  const meta = fromMeta(msg.from);
  const chatId = String(msg.chat?.id ?? meta.fromId);
  if (!meta.fromId) return null;

  if (typeof msg.text === "string" && msg.text.length > 0) {
    const text = msg.text;
    const cmdMatch = /^\/(start|stop)(?:@\w+)?\s*$/i.exec(text.trim());
    if (cmdMatch) {
      return { kind: "command", updateId, chatId, ...meta, command: cmdMatch[1].toLowerCase() as "start" | "stop" };
    }
    return { kind: "text", updateId, chatId, ...meta, text };
  }

  if (msg.contact) {
    return {
      kind: "contact",
      updateId,
      chatId,
      ...meta,
      contactUserId: typeof msg.contact.user_id === "number" ? msg.contact.user_id : null,
      phoneNumber: typeof msg.contact.phone_number === "string" ? msg.contact.phone_number : "",
      selfShared: typeof msg.contact.user_id === "number" && msg.contact.user_id === meta.fromId,
    };
  }

  if (msg.location && typeof msg.location.latitude === "number" && typeof msg.location.longitude === "number") {
    return {
      kind: "location",
      updateId,
      chatId,
      ...meta,
      latitude: msg.location.latitude,
      longitude: msg.location.longitude,
    };
  }

  const mediaType = msg.voice ? "voice"
    : msg.photo?.length ? "photo"
    : msg.document ? "document"
    : msg.audio ? "audio"
    : msg.video ? "video"
    : null;
  if (mediaType) {
    const fileId: string = mediaType === "photo"
      ? String(msg.photo[msg.photo.length - 1]?.file_id ?? "")
      : String(msg[mediaType]?.file_id ?? "");
    if (!fileId) return null;
    return {
      kind: "media",
      updateId,
      chatId,
      ...meta,
      mediaType,
      fileId,
      mimeType: typeof msg[mediaType]?.mime_type === "string" ? msg[mediaType].mime_type : null,
      caption: typeof msg.caption === "string" ? msg.caption : "",
    };
  }

  return null;
}

// ── Processing (post-ack) ────────────────────────────────────────────────────

// === W47 crosscutting (ONB-I18N-1): TG consent copy goes through the i18n
// locale packs (en/fr/ha/yo/ig/sw/am) — informed consent requires a language
// the buyer understands. The base WA pack text mentions WhatsApp; the TG
// variants are appended below per locale. ===
const TG_CONSENT_PROMPT =
  "Before we continue: we'd like to send you order updates and offers here on Telegram. " +
  "Under NDPR this needs your consent. Reply YES to receive order updates, or NO to opt out. " +
  "You can change this anytime — send /stop to opt out.";

const TG_OPT_IN_REPLY = "Thank you! You've opted in to order updates on Telegram.";
// === W47 buyer (ONB-B-4): first-contact NO mirrors the WA J1 contract ===
const TG_DENIED_REPLY =
  "Understood — you've opted out of proactive order updates. " +
  "You can still message us anytime, and reply YES later to opt back in.";
const TG_STOP_REPLY =
  "You've been opted out of proactive messages on Telegram. " +
  "You can still message us anytime, and send /start to opt back in.";

// === W47 merchant === per-(tenant, chat) cooldown for the store-not-open reply.
const telegramIntakeBlockedCooldown = new Map<string, number>();
// === END W47 merchant ===

/**
 * W47 buyer (ONB-B-9): recordChannelOptIn throws ConsentRegrantRateLimited
 * when a withdrawn identity re-grants >3×/24h — send the explanation instead
 * of throwing into silence. Returns true when consent was actually granted
 * (false when blocked by the rate limit — no menu should follow a block).
 */
async function safeChannelOptIn(db: Db, cfg: TelegramTenantConfig, sessionKey: string, chatId: string, replyText: string = TG_OPT_IN_REPLY): Promise<boolean> {
  try {
    await recordChannelOptIn(db, { tenantId: cfg.tenantId, sessionKey, channel: CONSENT_CHANNEL_TELEGRAM });
    await sendTelegramTextReply(cfg.tenantId, chatId, replyText);
    return true;
  } catch (e: any) {
    const { ConsentRegrantRateLimited } = await import("./consent");
    if (e instanceof ConsentRegrantRateLimited) {
      await sendTelegramTextReply(cfg.tenantId, chatId, e.message);
      return false;
    }
    throw e;
  }
}

/**
 * W47 buyer (ONB-B-6): propagate a Telegram revocation to the LINKED
 * WhatsApp phone identity (verified self-share only) — one buyer, one
 * consent state across channels.
 */
async function propagateRevocationToLinkedChannels(db: Db, cfg: TelegramTenantConfig, sessionKey: string): Promise<void> {
  try {
    const { resolveIdentity, channelFromSessionKey } = await import("./channelIdentity");
    const parsed = channelFromSessionKey(sessionKey);
    const identity = await resolveIdentity(db, cfg.tenantId, parsed.channel, parsed.id);
    if (identity.phoneE164) {
      await recordChannelRevocation(db, { tenantId: cfg.tenantId, sessionKey: identity.phoneE164, channel: "whatsapp" });
    }
  } catch (e: any) {
    console.warn("[telegram-inbound] linked-channel revocation propagation failed:", e?.message);
  }
}

/** Locale-aware TG consent copy (channel-specific overrides where translated). */
async function tgConsentText(
  tenantId: string,
  sessionKey: string,
  text: string,
  key: "prompt" | "granted" | "denied",
): Promise<string> {
  try {
    const { resolveLocale, tr } = await import("./i18n");
    const locale = await resolveLocale({ tenantId, phone: sessionKey, text });
    // Channel-generic packs say "WhatsApp"; swap the channel word for TG.
    const wa = { prompt: "consentPrompt", granted: "consentGranted", denied: "consentDenied" } as const;
    const localized = tr(locale, wa[key]);
    return localized.replace(/WhatsApp/g, "Telegram");
  } catch {
    return key === "prompt" ? TG_CONSENT_PROMPT : key === "granted" ? TG_OPT_IN_REPLY : TG_STOP_REPLY;
  }
}

/**
 * The lifecycle gate on paid order intake — the SAME gate the WhatsApp webhook applies to every message
 * (draft/trial/pre-KYB tenants take no orders; a KYB-lapsed live tenant stops taking new ones). A blocked chat gets
 * one honest reply per 24h instead of a dead end. Returns true when the message may proceed. Fails OPEN on a lookup
 * error (logged): a transient DB error must not halt commerce for a healthy tenant.
 */
async function intakeAllowed(db: Db, cfg: TelegramTenantConfig, chatId: string): Promise<boolean> {
  // === W47 merchant (ONB-M-5 / ONB-M-8): channel parity with the WA webhook ===
  try {
    const { checkOrderIntakeAllowed } = await import("./onboardingLifecycle");
    const [tenantRow] = await db
      .select({ id: tenants.id, status: tenants.status, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, cfg.tenantId))
      .limit(1)
      .catch(() => [] as any[]);
    if (tenantRow) {
      const intake = await checkOrderIntakeAllowed(db, tenantRow);
      if (!intake.allowed) {
        console.warn(`[telegram-inbound] intake blocked (tenant=${cfg.tenantId}, reason=${intake.reason}) for chat ${chatId}`);
        const cooldownKey = `${cfg.tenantId}:${chatId}`;
        const last = telegramIntakeBlockedCooldown.get(cooldownKey) ?? 0;
        if (Date.now() - last > 24 * 3600 * 1000 && intake.buyerMessage) {
          telegramIntakeBlockedCooldown.set(cooldownKey, Date.now());
          await sendTelegramTextReply(cfg.tenantId, chatId, intake.buyerMessage)
            .catch((e: any) => console.warn("[telegram-inbound] store-not-open reply failed:", e?.message));
        }
        return false;
      }
    }
  } catch (e: any) {
    console.error("[telegram-inbound] intake gate error — processing anyway:", e?.message);
  }
  // === END W47 merchant ===
  return true;
}

/**
 * Deliver what the shared engines return, the way the WhatsApp webhook does: the interactive (button / list) form
 * when there is one, falling back to the plain-text reply if Telegram refuses it. Text is converted from WhatsApp
 * formatting to Telegram HTML (and escaped). `page` selects a page of a long list (the "More →" button).
 */
async function deliverInboundOutcome(
  cfg: TelegramTenantConfig,
  chatId: string,
  outcome: { reply?: string | null; interactive?: SendInteractiveInput },
  opts: { page?: number } = {},
): Promise<void> {
  if (outcome.interactive) {
    const rendered = renderInteractiveForTelegram(outcome.interactive);
    if (rendered) {
      try {
        const tg = await import("./telegramSender");
        if (rendered.kind === "keyboard") {
          await tg.sendTelegramKeyboard(cfg.tenantId, chatId, rendered.text, rendered.buttons, { notifType: "menu" });
        } else {
          await tg.sendTelegramList(cfg.tenantId, chatId, rendered.text, rendered.rows, { notifType: "menu", page: opts.page });
        }
        return;
      } catch (e: any) {
        console.error("[telegram-inbound] interactive send failed — falling back to text:", e?.message);
      }
    }
  }
  if (outcome.reply) {
    await sendTelegramTextReply(cfg.tenantId, chatId, waMarkdownToTelegramHtml(outcome.reply));
  }
}

/** The tenant row the shared engines read (name for the greeting; settings for the menu, FAQ and admin phone). */
async function loadEngineTenant(db: Db, tenantId: string) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1).catch(() => [] as any[]);
  return t ?? null;
}

/**
 * Run a typed message through the SAME conversational menu/session engine the WhatsApp webhook runs first
 * (menu keywords, numeric choices, use-case flows, FAQ, finance Q&A, human handoff). Consent, STOP, erasure and the
 * language picker were already handled by the Telegram gates, so the engine only ever sees an opted-in chat.
 * Returns true when the engine answered; false → the caller falls through to the NLP assistant, exactly as on
 * WhatsApp. An engine error also falls through (logged), never dropping the message.
 */
async function runMenuEngine(db: Db, cfg: TelegramTenantConfig, ev: { chatId: string; name: string }, text: string): Promise<boolean> {
  let outcome: Awaited<ReturnType<typeof import("./useCases").handleConversationalInbound>>;
  try {
    const { handleConversationalInbound } = await import("./useCases");
    outcome = await handleConversationalInbound({
      db,
      tenant: await loadEngineTenant(db, cfg.tenantId),
      tenantId: cfg.tenantId,
      phone: sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId),
      text,
      customerName: ev.name || undefined,
      channel: CHANNEL_TELEGRAM,
    });
  } catch (e: any) {
    console.error("[telegram-inbound] menu engine error — falling back to NLP:", e?.message);
    return false;
  }
  if (!outcome.handled) return false;
  // A delivery failure must not send the message on to NLP as well (the engine already changed session state).
  await deliverInboundOutcome(cfg, ev.chatId, outcome)
    .catch((e: any) => console.error("[telegram-inbound] menu reply send error:", e?.message));
  return true;
}

/** Callback ids the NLP assistant resolves itself on Telegram (merchant approval cards); everything else is the engine's. */
const NLP_CALLBACK_ID = /^(?:catalog_ai|addrchg|offer):/;

/**
 * A tap on a button or list row: `menu_<n>`, `order_<action>:<id>`, purchase-order Approve/Reject — the SAME ids and
 * the SAME handler as a WhatsApp reply-button tap. Returns true when handled; false → the caller sends the id to NLP.
 */
async function runInteractiveEngine(db: Db, cfg: TelegramTenantConfig, ev: { chatId: string; name: string }, id: string): Promise<boolean> {
  if (NLP_CALLBACK_ID.test(id)) return false;
  let outcome: Awaited<ReturnType<typeof import("./useCases").handleInteractiveInbound>>;
  try {
    const { handleInteractiveInbound } = await import("./useCases");
    outcome = await handleInteractiveInbound({
      db,
      tenant: await loadEngineTenant(db, cfg.tenantId),
      tenantId: cfg.tenantId,
      phone: sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId),
      replyId: id,
      // No replyTitle: on Telegram the "title" is the raw id, and an id the engine does not know must reach NLP, not
      // be replayed to the engine as if the customer had typed it.
      customerName: ev.name || undefined,
      channel: CHANNEL_TELEGRAM,
    });
  } catch (e: any) {
    console.error("[telegram-inbound] interactive engine error — falling back to NLP:", e?.message);
    return false;
  }
  if (!outcome.handled) return false;
  await deliverInboundOutcome(cfg, ev.chatId, outcome)
    .catch((e: any) => console.error("[telegram-inbound] interactive reply send error:", e?.message));
  return true;
}

/**
 * "More →" on a long menu list: `menu_more_<offset>`. The menu is rebuilt from the tenant's config (no per-chat
 * state to lose across replicas) and the requested page is sent. Returns true when the id was a page request.
 */
async function runMenuPage(db: Db, cfg: TelegramTenantConfig, ev: { chatId: string }, id: string): Promise<boolean> {
  const m = /^menu_more_(\d{1,4})$/.exec(id);
  if (!m) return false;
  try {
    const { renderInteractiveMenuForCaller } = await import("./useCases");
    const { TG_LIST_PAGE_SIZE } = await import("./telegramSender");
    const interactive = await renderInteractiveMenuForCaller({
      db,
      tenant: await loadEngineTenant(db, cfg.tenantId),
      tenantId: cfg.tenantId,
      phone: sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId),
      channel: CHANNEL_TELEGRAM,
    });
    if (interactive) await deliverInboundOutcome(cfg, ev.chatId, { interactive }, { page: Math.floor(Number(m[1]) / TG_LIST_PAGE_SIZE) });
  } catch (e: any) {
    console.error("[telegram-inbound] menu page error:", e?.message);
  }
  return true;
}

/**
 * Feed a text-equivalent message through the SAME NLP engine the WA webhook
 * uses (session keyed `telegram:<chat_id>` via the nlp.ts W37 seam) and
 * deliver the reply over Telegram, followed by the same rich follow-ups WhatsApp
 * sends: the order action card after an order confirmation and a product's picture.
 * `gated` — the caller already ran the intake gate for this message.
 */
async function dispatchToNlp(
  db: Db,
  cfg: TelegramTenantConfig,
  ev: { chatId: string; name: string },
  message: string,
  opts: { gated?: boolean } = {},
): Promise<void> {
  if (!opts.gated && !(await intakeAllowed(db, cfg, ev.chatId))) return;
  const sessionKey = sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId);
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller({ user: null } as any);
  const result: any = await caller.nlp.processMessage({
    tenantId: cfg.tenantId,
    waPhoneNumber: sessionKey,
    message,
    customerName: ev.name || undefined,
    channel: CHANNEL_TELEGRAM,
  });
  let reply: string = typeof result?.reply === "string" ? result.reply : "";
  // The payment link stays in the text as well as behind the card's Pay button, so it is never one tap away only.
  const paymentUrl: string | null = result?.orderCard?.paymentUrl ?? null;
  if (paymentUrl && !reply.includes(paymentUrl)) {
    reply = `${reply}\n\nPay here: ${paymentUrl}`.trim();
  }
  if (reply) {
    await sendTelegramTextReply(cfg.tenantId, ev.chatId, waMarkdownToTelegramHtml(reply));
  }
  // WhatsApp follow-ups, sent the same way here (each best-effort, like the WhatsApp webhook).
  const orderCard = result?.orderCard as { orderId?: string; orderNumber?: string } | undefined;
  if (orderCard?.orderId && orderCard?.orderNumber) {
    try {
      const { buildOrderActionCard } = await import("./useCases");
      await deliverInboundOutcome(cfg, ev.chatId, { interactive: buildOrderActionCard({ orderId: orderCard.orderId, orderNumber: orderCard.orderNumber }) });
    } catch (e: any) {
      console.error("[telegram-inbound] order action card send error:", e?.message);
    }
  }
  const productImage = result?.productImage as { link?: string; caption?: string } | undefined;
  if (productImage?.link) {
    try {
      const { sendTelegramMedia } = await import("./telegramSender");
      await sendTelegramMedia(
        cfg.tenantId,
        ev.chatId,
        { type: "photo", url: productImage.link, caption: productImage.caption ? waMarkdownToTelegramHtml(productImage.caption) : undefined },
        { notifType: "product_image" },
      );
    } catch (e: any) {
      console.error("[telegram-inbound] product image send error:", e?.message);
    }
  }
}

/**
 * Consent gate mirroring useCases.handleConversationalInbound:
 * no consent row → YES/NO is recorded, anything else gets the opt-in prompt;
 * an existing row (granted or denied) lets the conversation proceed (denial
 * only blocks proactive sends, matching WA). Returns true when the event was
 * fully handled by the consent flow.
 */
async function consentGate(
  db: Db,
  cfg: TelegramTenantConfig,
  ev: { chatId: string; name: string },
  text: string,
): Promise<boolean> {
  const sessionKey = sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId);
  const existing = await getChannelConsent(db, cfg.tenantId, sessionKey, CONSENT_CHANNEL_TELEGRAM);
  if (existing) return false; // decided already — conversation proceeds
  const decision = parseConsentReply(text);
  if (decision === true) {
    // W47 (B ONB-B-9 rate-limit guard + D ONB-I18N-1 localized reply).
    // WA parity: a fresh grant bundles the welcome menu into the SAME turn (handleConversationalInbound returns
    // "consentGranted\n\nmenu" together) — show it here too rather than leave the buyer with only a confirmation.
    if (await safeChannelOptIn(db, cfg, sessionKey, ev.chatId, await tgConsentText(cfg.tenantId, sessionKey, text, "granted"))) {
      await runMenuEngine(db, cfg, ev, "menu").catch((e: any) => console.error("[telegram-inbound] post-consent menu error:", e?.message));
    }
    return true;
  }
  if (decision === false) {
    // === W47 buyer (ONB-B-4): first-contact NO is NOT a revocation — record
    // a granted=false row WITHOUT withdrawnAt (mirror the WA J1 contract:
    // limited service, can still chat). STOP semantics stay with
    // recordChannelRevocation. ===
    const { recordChannelDenial } = await import("./consent");
    await recordChannelDenial(db, { tenantId: cfg.tenantId, sessionKey, channel: CONSENT_CHANNEL_TELEGRAM });
    await sendTelegramTextReply(cfg.tenantId, ev.chatId, await tgConsentText(cfg.tenantId, sessionKey, text, "denied"));
    return true;
  }
  // W47 (ONB-I18N-1): localized prompt.
  await sendTelegramTextReply(cfg.tenantId, ev.chatId, await tgConsentText(cfg.tenantId, sessionKey, text, "prompt"));
  return true;
}

// === W46 platform-p2 (MSG-23) === low-confidence locale → language picker.
// Mirrors the WhatsApp gate in useCases.handleConversationalInbound: sticky
// locale wins; a pending picker consumes the reply (choice → sticky +
// confirmation, anything else → re-show picker); weak/unsupported detection
// opens the picker ONCE per session. Never throws (post-ack path).
async function telegramLanguagePickerGate(
  db: Db,
  cfg: TelegramTenantConfig,
  ev: { chatId: string },
  text: string,
): Promise<boolean> {
  try {
    const sessionKey = sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId);
    const i18n = await import("./i18n");
    const { getSession, saveSession, clearSession, newSession } = await import("./chatSession");
    const session = await getSession(cfg.tenantId, sessionKey).catch(() => null);
    if (session?.awaitingLanguageChoice) {
      const choice = i18n.parseLanguageChoice(text);
      if (choice) {
        await i18n.setStickyLocale(cfg.tenantId, sessionKey, choice).catch(() => {});
        await clearSession(cfg.tenantId, sessionKey).catch(() => {});
        await sendTelegramTextReply(
          cfg.tenantId,
          ev.chatId,
          i18n.t27(choice, "languageSetConfirm", { language: i18n.LOCALE_NAMES[choice] }),
        );
      } else {
        await sendTelegramTextReply(cfg.tenantId, ev.chatId, i18n.buildLanguageMenu("en"));
      }
      return true;
    }
    const sticky = await i18n.getStickyLocale(cfg.tenantId, sessionKey).catch(() => null);
    if (sticky) return false;
    const det = i18n.detectLocaleDetailed(text);
    // Zero-signal text (score 0) is ordinary commerce/chat text — never
    // hijack it with the picker; only weak-but-real supported-locale signal.
    if (!det.lowConfidence || det.score <= 0 || session?.languagePickerOffered || session?.mode === "usecase") return false;
    // Commerce-text guard: an order attempt that names a catalog product
    // ("2 jollof") must NOT be hijacked by the picker.
    const { products } = await import("../../drizzle/schema");
    const names = await db
      .select({ name: products.name })
      .from(products)
      .where(eq(products.tenantId, cfg.tenantId))
      .limit(200)
      .catch(() => [] as Array<{ name: string | null }>);
    if (i18n.sharesTokenWithCatalog(text, names.map((n) => n.name).filter((n): n is string => !!n))) return false;
    await saveSession({
      ...(session ?? newSession(cfg.tenantId, sessionKey)),
      awaitingLanguageChoice: true,
      languagePickerOffered: true,
    }).catch(() => {});
    await sendTelegramTextReply(cfg.tenantId, ev.chatId, i18n.buildLanguageMenu(det.locale));
    return true;
  } catch (e: any) {
    console.warn("[telegram-inbound] language-picker gate failed (fail-open):", e?.message);
    return false;
  }
}
// === END W46 platform-p2 (MSG-23) ===

/**
 * Process one normalized update AFTER the 200 ack. Never throws — every
 * branch fail-softs with a log (Telegram has already been acked).
 */
export async function processTelegramUpdate(
  db: Db,
  cfg: TelegramTenantConfig,
  update: any,
): Promise<void> {
  const ev = normalizeUpdate(update);
  if (!ev) return;
  const sessionKey = sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId);

  try {
    switch (ev.kind) {
      case "command": {
        if (ev.command === "start") {
          // WhatsApp's equivalent (a fresh YES reply) shows the welcome menu in the SAME breath as the opt-in
          // confirmation — /start must do the same, or a buyer who just tapped "Start" has no idea what to do next.
          if (await safeChannelOptIn(db, cfg, sessionKey, ev.chatId)) {
            await runMenuEngine(db, cfg, ev, "menu").catch((e: any) => console.error("[telegram-inbound] post-/start menu error:", e?.message));
          }
        } else {
          await recordChannelRevocation(db, { tenantId: cfg.tenantId, sessionKey, channel: CONSENT_CHANNEL_TELEGRAM });
          await propagateRevocationToLinkedChannels(db, cfg, sessionKey); // W47 ONB-B-6
          await sendTelegramTextReply(cfg.tenantId, ev.chatId, TG_STOP_REPLY);
        }
        return;
      }

      case "contact": {
        // Phone linkage ONLY on an explicit self-share.
        if (!ev.selfShared) {
          console.warn(
            `[telegram-inbound] ignoring contact-share where contact.user_id (${ev.contactUserId}) ` +
            `!= from.id (${ev.fromId}) — phone linkage is never inferred`,
          );
          await sendTelegramTextReply(
            cfg.tenantId,
            ev.chatId,
            "I can only link a phone number you share about yourself (use the share-contact button).",
          );
          return;
        }
        const phoneE164 = ev.phoneNumber.replace(/[^\d]/g, "");
        await bindTelegramPhone(db, {
          tenantId: cfg.tenantId,
          chatId: ev.chatId,
          phoneE164: phoneE164 || null,
          username: ev.username,
          linkedVia: "telegram_contact_share",
        });
        await sendTelegramTextReply(cfg.tenantId, ev.chatId, "Thanks — your phone number is now linked to this chat.");
        return;
      }

      case "callback": {
        // Ack within Telegram's 10s window, then clear the keyboard so the
        // button can't be double-tapped, THEN dispatch the SAME id the WA
        // interactive path would receive.
        await ackCallbackQuery(cfg.tenantId, ev.callbackQueryId);
        const tapId = ev.interactive.id;
        // "More →" keeps the list on screen (the customer may still pick from the page above); every other tap
        // clears its keyboard so it cannot be pressed twice.
        if (ev.messageId !== null && !/^menu_more_\d/.test(tapId)) {
          await clearInlineKeyboard(cfg.tenantId, ev.chatId, ev.messageId);
        }
        if (await consentGate(db, cfg, ev, tapId)) return;
        if (!(await intakeAllowed(db, cfg, ev.chatId))) return;
        if (await runMenuPage(db, cfg, ev, tapId)) return;
        if (await runInteractiveEngine(db, cfg, ev, tapId)) return;
        await dispatchToNlp(db, cfg, ev, tapId, { gated: true });
        return;
      }

      case "location": {
        if (!(await hasChannelConsent(cfg.tenantId, sessionKey, CONSENT_CHANNEL_TELEGRAM))) {
          if (await consentGate(db, cfg, ev, "")) return;
        }
        // SAME location event the WA path emits: format the address and feed
        // it through the deterministic checkout/address NLP step.
        const { formatLocationAddress } = await import("./locationInbound");
        const addressText = formatLocationAddress({ latitude: ev.latitude, longitude: ev.longitude } as any);
        await dispatchToNlp(db, cfg, ev, addressText);
        return;
      }

      case "media": {
        if (!telegramMediaEnabled()) {
          await sendTelegramTextReply(
            cfg.tenantId,
            ev.chatId,
            "Thanks! Media messages aren't enabled on Telegram yet — please describe it in text.",
          );
          return;
        }
        if (ev.mediaType === "voice" || ev.mediaType === "audio") {
          const file = await tgDownloadFile(cfg.tenantId, ev.fileId);
          if (!file) {
            await sendTelegramTextReply(cfg.tenantId, ev.chatId, "Sorry, I couldn't download that voice note — please try again.");
            return;
          }
          // Same transcription core the WA voice-note pipeline uses.
          const { transcribeAudio } = await import("./transcribe");
          const tr = await transcribeAudio({ audio: file.buffer, mimeType: ev.mimeType ?? "audio/ogg" });
          if (!tr.text) {
            await sendTelegramTextReply(cfg.tenantId, ev.chatId, "Sorry, I couldn't transcribe that voice note — please type it out.");
            return;
          }
          if (await consentGate(db, cfg, ev, tr.text)) return;
          await dispatchToNlp(db, cfg, ev, tr.text);
          return;
        }
        // === W43 dispatch (Coder C): proof-of-delivery photo. Claims ONLY
        // when the sender has an order in the awaiting-POD state (tenant
        // requirePod + shipment out_for_delivery/in_transit); anything else
        // falls through to the honest degrade below unchanged. ===
        if (ev.mediaType === "photo") {
          try {
            const file = await tgDownloadFile(cfg.tenantId, ev.fileId);
            if (file) {
              const { handleInboundPodPhotoTelegram } = await import("./deliveryProof");
              const pod = await handleInboundPodPhotoTelegram({
                tenantId: cfg.tenantId,
                chatId: ev.chatId,
                buffer: file.buffer,
                mimeType: ev.mimeType ?? "image/jpeg",
                fileId: ev.fileId,
              });
              if (pod.handled) return;
            }
          } catch (e: any) {
            console.warn("[telegram-inbound] POD capture error:", e?.message);
          }
        }
        // === END W43 dispatch ===
        // Honest degrade: the WA visual-search/receipt chain is keyed on
        // Graph media ids + waSender replies; Telegram photo/document parity
        // is outbound-sender work (Coder A/C). Say so rather than dropping.
        await sendTelegramTextReply(
          cfg.tenantId,
          ev.chatId,
          "Thanks! Image/document processing isn't available on Telegram yet — please describe it in text.",
        );
        return;
      }

      case "text": {
        // STOP as plain text revokes, same as /stop (Telegram does STOP
        // correctly from day one). parseConsentReply already classifies
        // "stop" as a denial; handle it explicitly for the revocation audit.
        // W40 MSG-1 parity: the shared canonical keyword set (stop/unsubscribe/
        // opt-out/quit/end) revokes — same as WhatsApp.
        const { isOptOutKeyword, wasRevoked, auditConsentWithdrawal } = await import("./optOut");
        if (isOptOutKeyword(ev.text)) {
          const existing = await getChannelConsent(db, cfg.tenantId, sessionKey, CONSENT_CHANNEL_TELEGRAM);
          await recordChannelRevocation(db, { tenantId: cfg.tenantId, sessionKey, channel: CONSENT_CHANNEL_TELEGRAM });
          await propagateRevocationToLinkedChannels(db, cfg, sessionKey); // W47 ONB-B-6
          if (!wasRevoked(existing)) {
            await auditConsentWithdrawal({ tenantId: cfg.tenantId, sessionKey, channel: CONSENT_CHANNEL_TELEGRAM });
          }
          await sendTelegramTextReply(cfg.tenantId, ev.chatId, TG_STOP_REPLY);
          return;
        }
        // W40 MSG-1 parity: a revoked identity stays silent on ALL subsequent
        // inbound until an explicit re-opt-in (YES-style keyword via the same
        // parseConsentReply classifier). Matches the WhatsApp interceptor.
        const tgConsent = await getChannelConsent(db, cfg.tenantId, sessionKey, CONSENT_CHANNEL_TELEGRAM);
        if (wasRevoked(tgConsent)) {
          if (parseConsentReply(ev.text) === true) {
            // WA parity: re-granting from a revoked state ALSO bundles the menu into the same turn.
            if (await safeChannelOptIn(db, cfg, sessionKey, ev.chatId)) { // W47 ONB-B-9
              await runMenuEngine(db, cfg, ev, "menu").catch((e: any) => console.error("[telegram-inbound] post-regrant menu error:", e?.message));
            }
          }
          return; // bot silent otherwise — no NLP dispatch, no reply
        }
        // === W47 buyer (ONB-B-8): chat self-service erasure (WA parity) ===
        {
          const { handleChatErasureCommand } = await import("./useCases");
          const outcome = await handleChatErasureCommand({
            db, tenantId: cfg.tenantId, phone: sessionKey, text: ev.text,
          });
          if (outcome?.handled) {
            if (outcome.reply) await sendTelegramTextReply(cfg.tenantId, ev.chatId, outcome.reply);
            return;
          }
        }
        // === END W47 buyer ===
        if (await consentGate(db, cfg, ev, ev.text)) return;
        // === W46 platform-p2 (MSG-23) === channel parity with WhatsApp:
        // low-confidence locale detection → language picker (never silent
        // sticky English).
        if (await telegramLanguagePickerGate(db, cfg, ev, ev.text)) return;
        // === END W46 platform-p2 (MSG-23) ===
        // Same order as the WhatsApp webhook: the lifecycle gate, then the menu/session engine, then NLP.
        if (!(await intakeAllowed(db, cfg, ev.chatId))) return;
        if (await runMenuEngine(db, cfg, ev, ev.text)) return;
        await dispatchToNlp(db, cfg, ev, ev.text, { gated: true });
        return;
      }
    }
  } catch (e: any) {
    console.error(`[telegram-inbound] processing error (tenant=${cfg.tenantId}, kind=${ev.kind}):`, e?.message);
  }
}
// === END W37 telegram ===
