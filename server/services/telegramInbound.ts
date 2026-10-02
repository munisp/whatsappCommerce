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
  | { kind: "command"; updateId: number; chatId: string; fromId: number; username: string | null; name: string; command: "start" | "stop" | "menu" }
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
    // === W50 CHANNELS === /menu joins start/stop as a first-class command.
    const cmdMatch = /^\/(start|stop|menu)(?:@\w+)?\s*$/i.exec(text.trim());
    if (cmdMatch) {
      return { kind: "command", updateId, chatId, ...meta, command: cmdMatch[1].toLowerCase() as "start" | "stop" | "menu" };
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
 * of throwing into silence.
 */
async function safeChannelOptIn(db: Db, cfg: TelegramTenantConfig, sessionKey: string, chatId: string, replyText: string = TG_OPT_IN_REPLY): Promise<void> {
  try {
    await recordChannelOptIn(db, { tenantId: cfg.tenantId, sessionKey, channel: CONSENT_CHANNEL_TELEGRAM });
    await sendTelegramTextReply(cfg.tenantId, chatId, replyText);
  } catch (e: any) {
    const { ConsentRegrantRateLimited } = await import("./consent");
    if (e instanceof ConsentRegrantRateLimited) {
      await sendTelegramTextReply(cfg.tenantId, chatId, e.message);
      return;
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

// === W50 CHANNELS (Q1: TG menu-engine parity) ===
/**
 * Render the tenant's settings.waMenu config as a Telegram inline-keyboard
 * list — the SAME menu engine the WA webhook uses (loadMenuConfig +
 * buildMenuEntries), with `menu_<n>` callback ids preserved verbatim so a
 * tap resolves through handleInteractiveInbound exactly like a WA list row.
 * `page` drives the menu_more_<offset> pagination sendTelegramList emits.
 */
export async function sendTelegramMenu(
  db: Db,
  cfg: TelegramTenantConfig,
  chatId: string | number,
  page = 0,
): Promise<void> {
  const [tenantRow] = await db
    .select({ name: tenants.name, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, cfg.tenantId))
    .limit(1)
    .catch(() => [] as any[]);
  const { loadMenuConfig, buildMenuEntries, renderMenu, menuEntryReplyId } = await import("./waMenu");
  const config = loadMenuConfig(tenantRow ?? null);
  const entries = buildMenuEntries(config);
  const text = renderMenu(config, { businessName: (tenantRow?.name as string) ?? undefined });
  const rows = entries.map((e) => ({ id: menuEntryReplyId(e), title: e.label }));
  const { sendTelegramList } = await import("./telegramSender");
  await sendTelegramList(cfg.tenantId, String(chatId), text, rows, { notifType: "menu", page });
}

/**
 * Deliver a WA SendInteractiveInput over Telegram: button → inline keyboard,
 * list → paginated keyboard list, cta_url → URL button. Keeps the SAME id
 * grammar so replies resolve identically on both channels.
 */
export async function sendTelegramInteractive(
  tenantId: string,
  chatId: string | number,
  input: { bodyText: string; action: any },
): Promise<void> {
  const { sendTelegramKeyboard, sendTelegramList } = await import("./telegramSender");
  const action = input.action ?? {};
  if (action.type === "button" && Array.isArray(action.buttons) && action.buttons.length) {
    await sendTelegramKeyboard(
      tenantId, String(chatId), input.bodyText,
      action.buttons.map((b: any) => ({ id: String(b.id ?? b.title), title: String(b.title ?? b.id) })),
    );
    return;
  }
  if (action.type === "list" && Array.isArray(action.sections)) {
    const rows = action.sections.flatMap((s: any) =>
      (Array.isArray(s?.rows) ? s.rows : []).map((r: any) => ({
        id: String(r.id ?? r.title), title: String(r.title ?? r.id),
      })));
    if (rows.length) {
      await sendTelegramList(tenantId, String(chatId), input.bodyText, rows);
      return;
    }
  }
  if (action.type === "cta_url" && action.url) {
    await sendTelegramKeyboard(
      tenantId, String(chatId), input.bodyText,
      [{ id: String(action.url), title: String(action.displayText ?? "Open"), url: String(action.url) }],
    );
    return;
  }
  await sendTelegramTextReply(tenantId, chatId, input.bodyText);
}
// === END W50 CHANNELS ===

/**
 * Feed a text-equivalent message through the SAME NLP engine the WA webhook
 * uses (session keyed `telegram:<chat_id>` via the nlp.ts W37 seam) and
 * deliver the reply over Telegram.
 */
async function dispatchToNlp(
  db: Db,
  cfg: TelegramTenantConfig,
  ev: { chatId: string; name: string },
  message: string,
): Promise<void> {
  // === W47 merchant (ONB-M-5 / ONB-M-8): channel parity with the WA
  // webhook — the SAME lifecycle gate blocks paid order intake for
  // draft/trial/pre-KYB tenants and KYB-lapsed live tenants, with the same
  // honest buyer-facing message (24h cooldown per chat). ===
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
        console.warn(`[telegram-inbound] intake blocked (tenant=${cfg.tenantId}, reason=${intake.reason}) for chat ${ev.chatId}`);
        const cooldownKey = `${cfg.tenantId}:${ev.chatId}`;
        const last = telegramIntakeBlockedCooldown.get(cooldownKey) ?? 0;
        if (Date.now() - last > 24 * 3600 * 1000 && intake.buyerMessage) {
          telegramIntakeBlockedCooldown.set(cooldownKey, Date.now());
          await sendTelegramTextReply(cfg.tenantId, ev.chatId, intake.buyerMessage)
            .catch((e: any) => console.warn("[telegram-inbound] store-not-open reply failed:", e?.message));
        }
        return;
      }
    }
  } catch (e: any) {
    console.error("[telegram-inbound] intake gate error — processing anyway:", e?.message);
  }
  // === END W47 merchant ===
  const sessionKey = sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId);
  // === W55 parity ===
  // PARITY-1 + PARITY-4: TG text never passes through
  // useCases.handleConversationalInbound (WA-only seam, _core/index.ts), so
  // mirror its deterministic pre-NLP keyword handlers here BEFORE the NLP
  // fallback — otherwise "stokvel contribute <id>", "insure", "voucher …"
  // and merchant finance Q&A fall to the LLM with nothing recorded.
  //   - savingsWa.handleSavingsInbound: stokvel status/contribute
  //     (claim-first/idempotent inside stokvels service), insure bind/menu,
  //     voucher status/redeem — unchanged semantics, same handler as WA.
  //   - financeQa.handleFinanceQa: read-only AP/AR keyword answers.
  //   - localized text "menu" (matchLocalizedIntent — e.g. "ahịa", "menyu")
  //     renders the SAME menu engine the /menu command uses (isMenuKeyword's
  //     English list is already handled in processTelegramUpdate).
  // Identity: these handlers key on an E.164 phone; resolve the linked
  // phone from telegramIdentities and fall back to the TG session key
  // (read-only lookups then simply find nothing and answer honestly).
  try {
    const { telegramIdentities } = await import("../../drizzle/schema");
    const { and: andOp } = await import("drizzle-orm");
    const [ident] = await db
      .select({ phone: telegramIdentities.phoneE164 })
      .from(telegramIdentities)
      .where(andOp(eq(telegramIdentities.tenantId, cfg.tenantId), eq(telegramIdentities.chatId, ev.chatId)))
      .limit(1)
      .catch(() => [] as any[]);
    const phoneRef: string = ident?.phone ?? sessionKey;
    const { handleSavingsInbound } = await import("./savingsWa");
    const savingsOutcome = await handleSavingsInbound({ db, tenantId: cfg.tenantId, phone: phoneRef, text: message });
    if (savingsOutcome) {
      if (savingsOutcome.reply) {
        await sendTelegramTextReply(cfg.tenantId, ev.chatId, savingsOutcome.reply)
          .catch((e: any) => console.warn("[telegram-inbound] savings reply failed:", e?.message));
      }
      return;
    }
    const { handleFinanceQa } = await import("./financeQa");
    const financeOutcome = await handleFinanceQa({ db, tenantId: cfg.tenantId, phone: phoneRef, text: message });
    if (financeOutcome) {
      if (financeOutcome.reply) {
        await sendTelegramTextReply(cfg.tenantId, ev.chatId, financeOutcome.reply)
          .catch((e: any) => console.warn("[telegram-inbound] finance Q&A reply failed:", e?.message));
      }
      return;
    }
    // === W56 credit === merchant credit-intelligence keywords (WA parity):
    // "CREDIT SCORE <customer>", "BUREAU CHECK <customer>" (consent-first,
    // never auto-pulls), "BUREAU CONFIRM <customer>" — admin-phone authz
    // inside the handler; TG identity resolves to the linked E.164 phone.
    if (/^\s*(?:BUREAU\s+(?:CHECK|CONFIRM)\s+\S+|CREDIT\s+(?:SCORE|RISK)\s+\S+)\s*$/i.test(message)) {
      const { handleCreditIntelCommand } = await import("./creditIntelligenceChat");
      const intelOutcome = await handleCreditIntelCommand({
        db, tenantId: cfg.tenantId, fromPhone: phoneRef, text: message, channel: "telegram",
      });
      if (intelOutcome) {
        if (intelOutcome.handled) {
          if (intelOutcome.reply) {
            await sendTelegramTextReply(cfg.tenantId, ev.chatId, intelOutcome.reply)
              .catch((e: any) => console.warn("[telegram-inbound] credit-intel reply failed:", e?.message));
          }
          return;
        }
      }
    }
    // === END W56 credit ===
    // === W58 statements === merchant "STATEMENT [month]" keyword (WA
    // parity): admin-phone authz inside the handler; TG identity resolves to
    // the linked E.164 phone upstream.
    if (/^\s*STATEMENT\b/i.test(message)) {
      const { handleStatementCommand } = await import("./walletStatementChat");
      const stOutcome = await handleStatementCommand({
        db, tenantId: cfg.tenantId, fromPhone: phoneRef, text: message, channel: "telegram",
      });
      if (stOutcome?.handled) {
        if (stOutcome.reply) {
          await sendTelegramTextReply(cfg.tenantId, ev.chatId, stOutcome.reply)
            .catch((e: any) => console.warn("[telegram-inbound] statement reply failed:", e?.message));
        }
        return;
      }
    }
    // === END W58 statements ===
    // === W59 banking-pos === merchant banking keywords (WA parity):
    // admin-phone authz inside the handler; TG identity resolves to the
    // linked E.164 phone upstream.
    if (/^\s*(BANK\s+ACCOUNTS?|CASH\s+(IN|OUT)\b|CONFIRM\s+CICO-|FLOAT|PAY\s+BY\s+POS)\b/i.test(message)) {
      const { handleBankingCommand } = await import("./bankingChat");
      const bkOutcome = await handleBankingCommand({
        db, tenantId: cfg.tenantId, fromPhone: phoneRef, text: message, channel: "telegram",
      });
      if (bkOutcome?.handled) {
        if (bkOutcome.reply) {
          await sendTelegramTextReply(cfg.tenantId, ev.chatId, bkOutcome.reply)
            .catch((e: any) => console.warn("[telegram-inbound] banking reply failed:", e?.message));
        }
        return;
      }
    }
    // === END W59 banking-pos ===
    const i18n = await import("./i18n");
    const locale = await i18n.resolveLocale({ tenantId: cfg.tenantId, phone: sessionKey, text: message }).catch(() => "en");
    if (i18n.matchLocalizedIntent(message, locale) === "menu") {
      await sendTelegramMenu(db, cfg, ev.chatId);
      return;
    }
  } catch (e: any) {
    console.warn("[telegram-inbound] W55 parity pre-NLP handlers failed (fail-open to NLP):", e?.message ?? e);
  }
  // === END W55 parity ===
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
  // === W49 RICHMEDIA (RICH-2) ===
  // Mirror the WA webhook rich delivery (server/_core/index.ts:960-979):
  // orderCard → inline keyboard (URL pay button when a payment link exists);
  // productImage → photo card with action buttons. Fail-open per send so a
  // rich-delivery error never eats the text reply.
  const richResult = {
    orderCard: result?.orderCard as { orderId?: string; orderNumber?: string; paymentUrl?: string | null } | undefined,
    productImage: result?.productImage as { link?: string; caption?: string; productId?: string } | undefined,
    browseProducts: result?.browseProducts as
      | Array<{ id: string; name: string; priceText: string; imageUrl?: string | null }>
      | undefined,
    // === W51 PROMOS ===
    promoCard: result?.promoCard as
      | { kind?: string; title?: string; discountText?: string; code?: string; imageUrl?: string | null }
      | undefined,
    language: result?.language as string | undefined,
  };
  const paymentUrl: string | null = richResult.orderCard?.paymentUrl ?? null;
  if (paymentUrl && !reply.includes(paymentUrl) && !richResult.orderCard?.orderId) {
    // Bare payment link (no order card) — keep the honest text fallback.
    reply = `${reply}\n\nPay here: ${paymentUrl}`.trim();
  }
  if (reply) {
    // === W50 CHANNELS (A3) === channel-aware discovery prompt: the NLP
    // engine flags location asks with `locationRequest` so Telegram renders
    // the native request_location reply keyboard instead of the WA-only
    // "tap 📎 → Location" instruction.
    if (result?.locationRequest === true) {
      const { sendTelegramLocationRequest } = await import("./telegramSender");
      await sendTelegramLocationRequest(cfg.tenantId, String(ev.chatId), reply);
    } else {
      await sendTelegramTextReply(cfg.tenantId, ev.chatId, reply);
    }
  }
  // === W49 RICHMEDIA (RICH-9 TG parity): welcome banner w/ tenant logo ===
  if (result?.intent === "greeting") {
    try {
      const { sendTelegramWelcomeBanner } = await import("./richMedia");
      await sendTelegramWelcomeBanner(cfg.tenantId, ev.chatId, "Welcome! 👋");
    } catch { /* banner is cosmetic — fail open */ }
  }
  await deliverTelegramRichAnnotations(cfg.tenantId, ev.chatId, richResult);
}

/**
 * RICH-2: deliver the NLP rich annotations on Telegram exactly like the WA
 * webhook does on WhatsApp. Exported for direct simulation coverage.
 * Never throws — every send is individually fail-open.
 */
export async function deliverTelegramRichAnnotations(
  tenantId: string,
  chatId: string,
  result: {
    orderCard?: { orderId?: string; orderNumber?: string; paymentUrl?: string | null };
    productImage?: { link?: string; caption?: string; productId?: string };
    browseProducts?: Array<{ id: string; name: string; priceText: string; imageUrl?: string | null }>;
    // === W51 PROMOS ===
    promoCard?: { kind?: string; title?: string; discountText?: string; code?: string; imageUrl?: string | null };
    language?: string;
  },
): Promise<void> {
  // W51: promo spotlight card LAST on inquiry turns (confirm_order turns
  // never annotate it, so the order action card keeps its pin position).
  if (result.promoCard?.title) {
    try {
      const { sendTelegramPromoCard } = await import("./promoSpotlight");
      const { localeFromSessionLanguage } = await import("./i18n");
      await sendTelegramPromoCard(tenantId, String(chatId), result.promoCard as any, {
        locale: localeFromSessionLanguage(result.language),
      });
    } catch (e: any) {
      console.error("[telegram-inbound] promo card send error:", e?.message);
    }
  }
  // RICH-5: browse → media-group album (TG approximation of WA product_list).
  if (result.browseProducts?.length) {
    try {
      const { sendTelegramBrowseAlbum } = await import("./richMedia");
      await sendTelegramBrowseAlbum(tenantId, chatId, result.browseProducts);
    } catch (e: any) {
      console.error("[telegram-inbound] browse album send error:", e?.message);
    }
  }
  const card = result.orderCard;
  if (card?.orderId && card?.orderNumber) {
    try {
      const { orderActionReplyId } = await import("./useCases");
      const { sendTelegramKeyboard } = await import("./telegramSender");
      const buttons = [
        { id: orderActionReplyId("track", card.orderId), title: "📦 Track Order" },
        ...(card.paymentUrl
          ? [{ id: card.paymentUrl, title: "💳 Pay Now", url: card.paymentUrl }]
          : [{ id: orderActionReplyId("pay", card.orderId), title: "💳 Pay Now" }]),
        { id: orderActionReplyId("cancel", card.orderId), title: "❌ Cancel Order" },
      ];
      await sendTelegramKeyboard(
        tenantId,
        chatId,
        `Order ${card.orderNumber} — manage it here:`,
        buttons,
        { notifType: "order_action_card" },
      );
    } catch (e: any) {
      console.error("[telegram-inbound] order action card send error:", e?.message);
    }
  }
  const productImage = result.productImage;
  if (productImage?.link) {
    try {
      const { sendTelegramProductCard } = await import("./richMedia");
      await sendTelegramProductCard(tenantId, chatId, {
        productId: productImage.productId ?? "unknown",
        name: productImage.caption ?? "Product",
        imageUrl: productImage.link,
      });
    } catch (e: any) {
      console.error("[telegram-inbound] product card send error:", e?.message);
    }
  }
}
// === END W49 RICHMEDIA ===

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
  ev: { chatId: string },
  text: string,
): Promise<boolean> {
  const sessionKey = sessionKeyFor(CHANNEL_TELEGRAM, ev.chatId);
  const existing = await getChannelConsent(db, cfg.tenantId, sessionKey, CONSENT_CHANNEL_TELEGRAM);
  if (existing) return false; // decided already — conversation proceeds
  const decision = parseConsentReply(text);
  if (decision === true) {
    // W47 (B ONB-B-9 rate-limit guard + D ONB-I18N-1 localized reply).
    await safeChannelOptIn(db, cfg, sessionKey, ev.chatId,
      await tgConsentText(cfg.tenantId, sessionKey, text, "granted"));
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
          await safeChannelOptIn(db, cfg, sessionKey, ev.chatId);
        } else if (ev.command === "menu") {
          // === W50 CHANNELS (A2) === /menu renders the tenant menu engine
          // config as an inline-keyboard list (mirrors the WA "menu"
          // keyword). A revoked identity stays silent (W40 contract).
          const { wasRevoked } = await import("./optOut");
          const consent = await getChannelConsent(db, cfg.tenantId, sessionKey, CONSENT_CHANNEL_TELEGRAM);
          if (wasRevoked(consent)) return;
          await sendTelegramMenu(db, cfg, ev.chatId);
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
        if (ev.messageId !== null) {
          await clearInlineKeyboard(cfg.tenantId, ev.chatId, ev.messageId);
        }
        if (await consentGate(db, cfg, ev, ev.interactive.id)) return;
        // === W50 CHANNELS (A1) === menu-engine parity: interactive callback
        // ids route through handleInteractiveInbound (menu_<n>, order_*,
        // supplier PO cards — the SAME resolution the WA webhook runs at
        // server/_core/index.ts) BEFORE the raw NLP fallback. A bare
        // menu_more_<offset> re-renders the tenant menu at the next page.
        {
          const more = /^menu_more_(\d+)$/.exec(ev.interactive.id);
          if (more) {
            const { TG_LIST_PAGE_SIZE } = await import("./telegramSender");
            await sendTelegramMenu(db, cfg, ev.chatId, Math.floor(parseInt(more[1], 10) / TG_LIST_PAGE_SIZE));
            return;
          }
          try {
            // === W50 MERGER FIX === TG callbacks set title === id, so an
            // unrecognized id (addrchg:*, offer:*, …) would always be
            // "handled" by handleInteractiveInbound's title→free-text
            // fallback and never reach the NLP callback-id handlers (the
            // pre-W50 path). Gate the engine dispatch to ids the engine
            // actually resolves — menu_<n>, PO action cards, order action
            // cards (mirrors the WA webhook, where addrchg/offer are peeled
            // off BEFORE handleInteractiveInbound). Anything else falls
            // through to dispatchToNlp exactly as before W50 (fixes J336 /
            // J346 regression).
            const { parsePoActionReplyId } = await import("./procurement/poFlow");
            const { parseOrderActionReplyId } = await import("./useCases");
            const { parseMenuEntryReplyId } = await import("./waMenu");
            const engineId =
              parseMenuEntryReplyId(ev.interactive.id) != null ||
              parsePoActionReplyId(ev.interactive.id) != null ||
              parseOrderActionReplyId(ev.interactive.id) != null ||
              // === W52 SHARE === promo-card 📤 Share taps resolve through the
              // SAME handleInteractiveInbound case as the WA reply button.
              /^promo_share:[A-Za-z0-9_-]{2,32}$/i.test(ev.interactive.id);
            if (!engineId) {
              await dispatchToNlp(db, cfg, ev, ev.interactive.id);
              return;
            }
            const [tenantRow] = await db
              .select({ id: tenants.id, name: tenants.name, settings: tenants.settings })
              .from(tenants)
              .where(eq(tenants.id, cfg.tenantId))
              .limit(1)
              .catch(() => [] as any[]);
            const { handleInteractiveInbound } = await import("./useCases");
            const outcome = await handleInteractiveInbound({
              db,
              tenant: tenantRow ?? null,
              tenantId: cfg.tenantId,
              phone: sessionKey,
              replyId: ev.interactive.id,
              replyTitle: ev.interactive.title,
              customerName: ev.name || undefined,
            });
            if (outcome.handled) {
              if (outcome.interactive) {
                await sendTelegramInteractive(cfg.tenantId, ev.chatId, outcome.interactive);
              } else if (outcome.reply) {
                await sendTelegramTextReply(cfg.tenantId, ev.chatId, outcome.reply);
              }
              return;
            }
          } catch (e: any) {
            // Fail-open: an interactive-resolution error never eats the tap —
            // fall through to the NLP path exactly as before W50.
            console.warn("[telegram-inbound] interactive dispatch failed (falling back to NLP):", e?.message);
          }
        }
        // === END W50 CHANNELS ===
        await dispatchToNlp(db, cfg, ev, ev.interactive.id);
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
            await safeChannelOptIn(db, cfg, sessionKey, ev.chatId); // W47 ONB-B-9
          }
          return; // bot silent — no NLP dispatch, no reply
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
        // === W50 CHANNELS (A2) === menu keyword ("menu") renders the SAME
        // tenant menu engine as the WA path instead of falling into NLP.
        {
          const { isMenuKeyword } = await import("./waMenu");
          if (isMenuKeyword(ev.text)) {
            await sendTelegramMenu(db, cfg, ev.chatId);
            return;
          }
        }
        // === END W50 CHANNELS ===
        await dispatchToNlp(db, cfg, ev, ev.text);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[telegram-inbound] processing error (tenant=${cfg.tenantId}, kind=${ev.kind}):`, e?.message);
  }
}
// === END W37 telegram ===
