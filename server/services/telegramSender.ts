// === W37 telegram ===
/**
 * Telegram Sender Service (SPEC_W37 Coder A) — Telegram Bot API client with
 * WhatsApp parity semantics, mirroring waSender.ts.
 *
 * Transport: plain HTTPS JSON against https://api.telegram.org/bot<token>/<method>
 * via the global fetch — NO new dependencies.
 *
 * Credential resolution: per-tenant bot token stored at
 * tenants.settings.telegram.botToken, encrypted with the SAME v1: envelope
 * helpers waSender config uses (crypto/secrets decryptSecret; legacy
 * plaintext passes through). No new crypto.
 *
 * Gating (fail-open, honest):
 *   - Global: TELEGRAM_ENABLED env, default FALSE. When unset/false every
 *     send is simulated (logged + outbox row status "simulated"), never throws.
 *   - Tenant: settings.telegram.enabled !== false AND a configured bot token;
 *     otherwise simulation mode (same convention as waSender).
 *
 * Retry/DLQ parity: failed sends land in telegram_outbox (migration 0117 —
 * whatsapp_notification_log is phone/wamid-keyed with no channel column, so
 * Telegram gets its own outbox; honest choice per SPEC §2). Classification
 * REUSES waSender's classifyWaSendError + WA_RETRY_BACKOFF_MS (1m/5m/15m/1h,
 * 4 attempts); Telegram 429 `parameters.retry_after` is honored on top of the
 * classified backoff. Exhausted sends go status "dead" and the tenant admin
 * is alerted via the EXISTING alert path (WhatsApp text to
 * settings.adminPhone, same as waSender.sendDeadLetterAlert).
 *
 * Interactive id grammar: inline-keyboard callback_data carries the EXISTING
 * button ids (menu_<n>, order_*, catalog_ai:*). The ONE additive id is
 * `menu_more_<offset>` for long-list "More" pagination (documented in
 * sendTelegramList) — it stays inside the menu_ namespace the menu engine
 * already owns.
 */

import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { getDb } from "../db";
import { telegramOutbox, tenants } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";
import {
  WA_RETRY_BACKOFF_MS,
  WA_RETRY_MAX_ATTEMPTS,
  chunkWhatsAppText,
  classifyWaSendError,
  retryBackoffMs,
} from "./waSender";

/** Telegram Bot API base (token interpolated per request — never logged). */
const TG_API_BASE = "https://api.telegram.org";
/** Telegram message text limit is 4096; chunk at 4000 like WA for safety. */
export const TG_TEXT_LIMIT = 4000;
/** Telegram inline-keyboard caps. */
export const TG_BUTTONS_PER_ROW = 2;
export const TG_BUTTON_TITLE_LIMIT = 64;
/** callback_data hard limit is 64 BYTES (Bot API). */
export const TG_CALLBACK_DATA_BYTES = 64;
/** Rows per page when rendering long lists as chunked keyboards. */
export const TG_LIST_PAGE_SIZE = 8;
/** Consent ledger channel key (channelEnum already includes "telegram"). */
export const CONSENT_CHANNEL_TELEGRAM = "telegram";

/** True when the Telegram channel is globally enabled (default false). */
export function telegramEnabled(): boolean {
  return (process.env.TELEGRAM_ENABLED ?? "").trim().toLowerCase() === "true";
}

export interface TelegramCredentials {
  botToken: string;
  source: "tenant";
}

export interface SendTelegramResult {
  sent: boolean;
  simulated: boolean;
  /** Bot API message_ids of the sent chunks (Telegram has no delivery receipts). */
  messageIds: number[];
  chunks: number;
}

export interface TelegramInlineButton {
  /** callback_data — the EXISTING id grammar (menu_<n>, order_*, catalog_ai:*). */
  id: string;
  title: string;
  /** URL buttons (e.g. payment links) carry a url instead of callback_data. */
  url?: string;
}

export interface TelegramListRow {
  id: string;
  title: string;
  description?: string;
}

/**
 * Resolve the Telegram bot token for a tenant from
 * settings.telegram.botToken (v1:-encrypted, decryptSecret passes legacy
 * plaintext through — same scheme as whatsapp.accessToken). Returns null when
 * unconfigured or the tenant disabled Telegram → simulation mode.
 */
export async function resolveTenantTelegramCredentials(
  tenantId: string | null | undefined,
): Promise<TelegramCredentials | null> {
  if (!telegramEnabled()) return null;
  if (!tenantId || tenantId === "default") return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const [t] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const tg = (((t?.settings as Record<string, unknown> | null)?.telegram ?? {}) as Record<string, unknown>);
    if (tg.enabled === false) return null; // per-tenant opt-out
    const rawToken = typeof tg.botToken === "string" ? tg.botToken : "";
    const botToken = rawToken ? decryptSecret(rawToken) : "";
    if (botToken.trim()) return { botToken: botToken.trim(), source: "tenant" };
  } catch (e: any) {
    // Fail open to simulation — never block a caller on a lookup error.
    console.warn("[telegramSender] tenant credential lookup failed:", e?.message);
  }
  return null;
}

// ── Payload builders ─────────────────────────────────────────────────────────

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

/** Escape user-controlled text for parse_mode HTML. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build a Bot API inline_keyboard markup. Button ids are used VERBATIM as
 * callback_data (existing grammar preserved); url buttons use `url`. Throws
 * on an empty id or callback_data over the 64-byte Bot API cap (caller bug).
 */
export function buildTelegramInlineKeyboard(
  buttons: TelegramInlineButton[],
  perRow: number = TG_BUTTONS_PER_ROW,
): Record<string, unknown> {
  if (!buttons.length) throw new Error("inline keyboard requires at least 1 button");
  const flat = buttons.map((b) => {
    const text = truncate((b.title ?? "").trim() || b.id, TG_BUTTON_TITLE_LIMIT);
    if (b.url?.trim()) return { text, url: b.url.trim() };
    if (!b.id?.trim()) throw new Error("inline keyboard button requires a non-empty id");
    if (Buffer.byteLength(b.id, "utf8") > TG_CALLBACK_DATA_BYTES) {
      throw new Error(`callback_data exceeds ${TG_CALLBACK_DATA_BYTES} bytes: ${b.id.slice(0, 40)}…`);
    }
    return { text, callback_data: b.id };
  });
  const rows: unknown[][] = [];
  for (let i = 0; i < flat.length; i += perRow) rows.push(flat.slice(i, i + perRow));
  return { inline_keyboard: rows };
}

/**
 * Build a Bot API reply-keyboard markup (request_location / request_contact
 * buttons — these are reply keyboards, not inline).
 */
export function buildTelegramReplyKeyboard(
  buttons: Array<Record<string, unknown>>,
  opts?: { resize?: boolean; oneTime?: boolean },
): Record<string, unknown> {
  return {
    keyboard: [buttons],
    resize_keyboard: opts?.resize ?? true,
    one_time_keyboard: opts?.oneTime ?? true,
  };
}

// ── Outbox logging ──────────────────────────────────────────────────────────

type TgDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface TgLogBase {
  tenantId: string;
  chatId: string;
  kind: string;
  payload?: Record<string, unknown> | null;
}

async function logSend(
  base: TgLogBase,
  outcome: {
    status: "sent" | "failed" | "simulated";
    messageId?: number | null;
    errorText?: string | null;
    failureClass?: "retriable" | "permanent";
    /** Telegram 429 retry_after (seconds) — honored over the standard backoff. */
    retryAfterSec?: number | null;
  },
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const now = new Date();
    const retriable = outcome.status === "failed" && (outcome.failureClass ?? "permanent") === "retriable";
    const retryMs = outcome.retryAfterSec
      ? Math.max(outcome.retryAfterSec * 1000, retryBackoffMs(1))
      : retryBackoffMs(1);
    await db.insert(telegramOutbox).values({
      id: crypto.randomUUID(),
      tenantId: base.tenantId,
      chatId: base.chatId,
      kind: base.kind,
      payload: base.payload ?? null,
      status: outcome.status,
      telegramMessageId: outcome.messageId ?? null,
      attempts: outcome.status === "failed" ? 1 : 0,
      nextRetryAt: retriable ? new Date(now.getTime() + retryMs) : null,
      lastError: outcome.status === "failed" ? (outcome.errorText ?? null) : null,
    });
  } catch (e: any) {
    // Fail-open: logging must never break a send path.
    console.warn("[telegramSender] outbox insert failed:", e?.message);
  }
}

// ── Core delivery ───────────────────────────────────────────────────────────

/** Extract Telegram's 429 retry_after (seconds) from a Bot API error body. */
export function parseTelegramRetryAfter(errBody: string): number | null {
  try {
    const parsed = JSON.parse(errBody) as any;
    const ra = parsed?.parameters?.retry_after;
    return typeof ra === "number" && ra > 0 ? ra : null;
  } catch {
    return null;
  }
}

/** Classify a failed Telegram send — identical policy to waSender. */
export const classifyTelegramSendError = classifyWaSendError;
export { WA_RETRY_BACKOFF_MS as TG_RETRY_BACKOFF_MS, WA_RETRY_MAX_ATTEMPTS as TG_RETRY_MAX_ATTEMPTS };

interface TgSendOpts {
  notifType?: string;
  kind?: string;
}

/**
 * Shared single-method delivery: credential resolution, outbox logging,
 * classified failure semantics identical to waSender.deliverWaPayload.
 * Throws on a non-OK Bot API response (after logging); simulates (never
 * throws) when Telegram is disabled/unconfigured.
 */
async function callTelegramApi(
  tenantId: string,
  chatId: string,
  method: string,
  body: Record<string, unknown>,
  opts?: TgSendOpts,
): Promise<{ messageId: number | null }> {
  const kind = opts?.kind ?? method;
  const logBase: TgLogBase = { tenantId, chatId, kind, payload: { method, body } };
  const creds = await resolveTenantTelegramCredentials(tenantId);
  if (!creds) {
    console.info(
      `[telegramSender] SIMULATION ${kind} (${tenantId}) → chat ${chatId}: ${JSON.stringify(body).slice(0, 120)}`,
    );
    await logSend(logBase, { status: "simulated" });
    const err = new Error("telegram-simulated") as any;
    err.simulated = true;
    throw err;
  }

  const url = `${TG_API_BASE}/bot${creds.botToken}/${method}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (netErr: any) {
    console.error(`[telegramSender] ${kind} network error:`, netErr?.message);
    await logSend(logBase, {
      status: "failed",
      errorText: `network: ${String(netErr?.message ?? netErr).slice(0, 500)}`,
      failureClass: "retriable",
    });
    throw new Error(`Telegram ${kind} send failed (network): ${netErr?.message ?? netErr}`);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[telegramSender] ${kind} API error ${res.status}: ${errBody}`);
    await logSend(logBase, {
      status: "failed",
      errorText: `Bot API ${res.status}: ${errBody.slice(0, 500)}`,
      failureClass: classifyTelegramSendError(res.status),
      retryAfterSec: res.status === 429 ? parseTelegramRetryAfter(errBody) : null,
    });
    throw new Error(`Telegram ${kind} send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as any;
  const messageId: number | null = typeof data?.result?.message_id === "number" ? data.result.message_id : null;
  await logSend(logBase, { status: "sent", messageId });
  return { messageId };
}

/** callTelegramApi variant that never throws — returns the send outcome. */
async function deliverTelegram(
  tenantId: string,
  chatId: string,
  method: string,
  body: Record<string, unknown>,
  opts?: TgSendOpts,
): Promise<{ sent: boolean; simulated: boolean; messageId: number | null }> {
  try {
    const { messageId } = await callTelegramApi(tenantId, chatId, method, body, opts);
    return { sent: true, simulated: false, messageId };
  } catch (e: any) {
    if (e?.simulated) return { sent: false, simulated: true, messageId: null };
    throw e;
  }
}

// ── Public senders (waSender parity surface) ────────────────────────────────

/**
 * Send a free-text Telegram message. Long text is chunked with the SAME
 * chunker as WhatsApp (chunkWhatsAppText) at TG_TEXT_LIMIT. parse_mode
 * defaults to HTML; link previews disabled by default.
 */
export async function sendTelegramText(
  tenantId: string,
  chatId: string,
  text: string,
  opts?: { parseMode?: "HTML" | "MarkdownV2"; disablePreview?: boolean; notifType?: string },
): Promise<SendTelegramResult> {
  const chunks = chunkWhatsAppText(text, TG_TEXT_LIMIT);
  const messageIds: number[] = [];
  let simulated = false;
  for (const chunk of chunks) {
    const r = await deliverTelegram(
      tenantId,
      chatId,
      "sendMessage",
      {
        text: chunk,
        parse_mode: opts?.parseMode ?? "HTML",
        disable_web_page_preview: opts?.disablePreview ?? true,
      },
      { notifType: opts?.notifType, kind: "text" },
    );
    simulated = simulated || r.simulated;
    if (r.messageId !== null) messageIds.push(r.messageId);
  }
  return { sent: !simulated, simulated, messageIds, chunks: chunks.length };
}

/**
 * Send an inline-keyboard message. callback_data carries the EXISTING button
 * id grammar verbatim (menu_<n>, order_*, catalog_ai:*); url buttons render
 * as Bot API URL buttons (Telegram's payment-link replacement for wa.me).
 */
export async function sendTelegramKeyboard(
  tenantId: string,
  chatId: string,
  text: string,
  buttons: TelegramInlineButton[],
  opts?: { notifType?: string; perRow?: number },
): Promise<SendTelegramResult> {
  const reply_markup = buildTelegramInlineKeyboard(buttons, opts?.perRow);
  const r = await deliverTelegram(
    tenantId,
    chatId,
    "sendMessage",
    { text: truncate(text, TG_TEXT_LIMIT), parse_mode: "HTML", disable_web_page_preview: true, reply_markup },
    { notifType: opts?.notifType, kind: "keyboard" },
  );
  return { sent: r.sent, simulated: r.simulated, messageIds: r.messageId !== null ? [r.messageId] : [], chunks: 1 };
}

/**
 * Send a long option list as chunked keyboards with "More" pagination.
 *
 * Page `page` (0-based) renders TG_LIST_PAGE_SIZE rows, numbered so the
 * numeric-reply equivalence the menu engine relies on still holds in plain
 * text. When further pages exist a final "More →" button is appended with
 * callback_data `menu_more_<offset>` — the ONE additive id, deliberately in
 * the menu_ namespace; the inbound side re-invokes the list renderer with
 * the next page (same pattern as USSD pagination).
 */
export async function sendTelegramList(
  tenantId: string,
  chatId: string,
  text: string,
  rows: TelegramListRow[],
  opts?: { notifType?: string; page?: number; perRow?: number },
): Promise<SendTelegramResult> {
  if (!rows.length) throw new Error("telegram list requires at least 1 row");
  const page = Math.max(opts?.page ?? 0, 0);
  const start = page * TG_LIST_PAGE_SIZE;
  const slice = rows.slice(start, start + TG_LIST_PAGE_SIZE);
  const buttons: TelegramInlineButton[] = slice.map((r, i) => ({
    id: r.id,
    title: `${start + i + 1}. ${r.title}`,
  }));
  const nextOffset = start + TG_LIST_PAGE_SIZE;
  if (nextOffset < rows.length) {
    buttons.push({ id: `menu_more_${nextOffset}`, title: `More → (${nextOffset + 1}–${Math.min(nextOffset + TG_LIST_PAGE_SIZE, rows.length)} of ${rows.length})` });
  }
  const header = page === 0 ? text : `${text}\n\n(continued — ${start + 1}–${start + slice.length} of ${rows.length})`;
  return sendTelegramKeyboard(tenantId, chatId, header, buttons, { notifType: opts?.notifType ?? "list_message", perRow: opts?.perRow ?? 1 });
}

/**
 * Send media (photo | document | voice) by public URL, by a previously
 * uploaded Telegram file_id, or by an in-memory buffer (multipart upload).
 */
export async function sendTelegramMedia(
  tenantId: string,
  chatId: string,
  input: {
    type: "photo" | "document" | "voice";
    url?: string;
    fileId?: string;
    buffer?: Buffer;
    caption?: string;
    filename?: string;
  },
  opts?: { notifType?: string },
): Promise<SendTelegramResult> {
  const method = input.type === "photo" ? "sendPhoto" : input.type === "document" ? "sendDocument" : "sendVoice";
  const field = input.type; // Bot API field name == type
  const sources = [input.url?.trim(), input.fileId?.trim(), input.buffer ? "buffer" : undefined].filter(Boolean);
  if (sources.length !== 1) throw new Error("telegram media requires exactly one of url, fileId or buffer");
  const caption = input.caption?.trim() ? truncate(input.caption.trim(), 1024) : undefined;

  const creds = await resolveTenantTelegramCredentials(tenantId);
  const logBase: TgLogBase = {
    tenantId,
    chatId,
    kind: `media:${input.type}`,
    // Buffers are not replayable — persist only the by-reference form.
    payload: input.buffer ? null : { method, body: { chat_id: chatId, [field]: input.url ?? input.fileId, caption } },
  };
  if (!creds) {
    console.info(`[telegramSender] SIMULATION media:${input.type} (${tenantId}) → chat ${chatId}`);
    await logSend(logBase, { status: "simulated" });
    return { sent: false, simulated: true, messageIds: [], chunks: 1 };
  }

  let bodyInit: BodyInit;
  const headers: Record<string, string> = {};
  if (input.buffer) {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append(field, new Blob([new Uint8Array(input.buffer)]), input.filename ?? `file.${input.type === "voice" ? "ogg" : "bin"}`);
    if (caption) form.append("caption", caption);
    bodyInit = form;
  } else {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify({ chat_id: chatId, [field]: input.url ?? input.fileId, ...(caption ? { caption, parse_mode: "HTML" } : {}) });
  }

  let res: Response;
  try {
    res = await fetch(`${TG_API_BASE}/bot${creds.botToken}/${method}`, {
      method: "POST",
      headers,
      body: bodyInit,
      signal: AbortSignal.timeout(20000), // media uploads get a longer window
    });
  } catch (netErr: any) {
    await logSend(logBase, { status: "failed", errorText: `network: ${String(netErr?.message ?? netErr).slice(0, 500)}`, failureClass: "retriable" });
    throw new Error(`Telegram media send failed (network): ${netErr?.message ?? netErr}`);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    await logSend(logBase, {
      status: "failed",
      errorText: `Bot API ${res.status}: ${errBody.slice(0, 500)}`,
      failureClass: classifyTelegramSendError(res.status),
      retryAfterSec: res.status === 429 ? parseTelegramRetryAfter(errBody) : null,
    });
    throw new Error(`Telegram media send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  const messageId: number | null = typeof data?.result?.message_id === "number" ? data.result.message_id : null;
  await logSend(logBase, { status: "sent", messageId });
  return { sent: true, simulated: false, messageIds: messageId !== null ? [messageId] : [], chunks: 1 };
}

/** Ask the buyer to share their location (request_location reply keyboard). */
export async function sendTelegramLocationRequest(
  tenantId: string,
  chatId: string,
  text: string,
  opts?: { notifType?: string; buttonTitle?: string },
): Promise<SendTelegramResult> {
  const reply_markup = buildTelegramReplyKeyboard([
    { text: opts?.buttonTitle ?? "📍 Share location", request_location: true },
  ]);
  const r = await deliverTelegram(
    tenantId,
    chatId,
    "sendMessage",
    { text: truncate(text || "Please share your delivery location", TG_TEXT_LIMIT), reply_markup },
    { notifType: opts?.notifType, kind: "location_request" },
  );
  return { sent: r.sent, simulated: r.simulated, messageIds: r.messageId !== null ? [r.messageId] : [], chunks: 1 };
}

/**
 * Ask the user to share their own phone number (request_contact reply
 * keyboard). This is the ONLY phone-linkage path — the inbound side must
 * verify contact.user_id == from.id before binding (never infer).
 */
export async function sendTelegramContactRequest(
  tenantId: string,
  chatId: string,
  text: string,
  opts?: { notifType?: string; buttonTitle?: string },
): Promise<SendTelegramResult> {
  const reply_markup = buildTelegramReplyKeyboard([
    { text: opts?.buttonTitle ?? "📱 Share phone number", request_contact: true },
  ]);
  const r = await deliverTelegram(
    tenantId,
    chatId,
    "sendMessage",
    { text: truncate(text || "Please share your phone number to link your account", TG_TEXT_LIMIT), reply_markup },
    { notifType: opts?.notifType, kind: "contact_request" },
  );
  return { sent: r.sent, simulated: r.simulated, messageIds: r.messageId !== null ? [r.messageId] : [], chunks: 1 };
}

/**
 * Ack a callback_query (MUST happen within ~10s or Telegram shows an error).
 * Fire-and-forget by contract: never throws, 5s timeout, returns false on
 * failure. Optional alert text (toast or modal when showAlert).
 */
export async function answerCallbackQuery(
  tenantId: string,
  callbackQueryId: string,
  opts?: { text?: string; showAlert?: boolean },
): Promise<boolean> {
  try {
    if (!callbackQueryId) return false;
    const creds = await resolveTenantTelegramCredentials(tenantId);
    if (!creds) {
      console.info(`[telegramSender] SIMULATION answerCallbackQuery (${tenantId}) ${callbackQueryId}`);
      return false;
    }
    const res = await fetch(`${TG_API_BASE}/bot${creds.botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(opts?.text ? { text: truncate(opts.text, 200) } : {}),
        ...(opts?.showAlert ? { show_alert: true } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[telegramSender] answerCallbackQuery failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn("[telegramSender] answerCallbackQuery error:", e?.message);
    return false;
  }
}

/**
 * Clear (or replace) a message's inline keyboard after a tap so buyers can't
 * double-tap stale buttons. Fire-and-forget: never throws.
 */
export async function editMessageReplyMarkup(
  tenantId: string,
  chatId: string,
  messageId: number,
  replyMarkup?: Record<string, unknown> | null,
): Promise<boolean> {
  try {
    const creds = await resolveTenantTelegramCredentials(tenantId);
    if (!creds) {
      console.info(`[telegramSender] SIMULATION editMessageReplyMarkup (${tenantId}) msg ${messageId}`);
      return false;
    }
    const res = await fetch(`${TG_API_BASE}/bot${creds.botToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[telegramSender] editMessageReplyMarkup failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn("[telegramSender] editMessageReplyMarkup error:", e?.message);
    return false;
  }
}

/** Telegram's read-receipt analogue: sendChatAction (default "typing"). */
export async function sendChatAction(
  tenantId: string,
  chatId: string,
  action: string = "typing",
): Promise<boolean> {
  try {
    const creds = await resolveTenantTelegramCredentials(tenantId);
    if (!creds) return false;
    const res = await fetch(`${TG_API_BASE}/bot${creds.botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Download an inbound file by file_id: getFile →
 * https://api.telegram.org/file/bot<token>/<file_path>. Used by the inbound
 * media pipeline (voice notes, receipts, photos). Throws on failure.
 */
export async function downloadTelegramFile(tenantId: string, fileId: string): Promise<Buffer> {
  const creds = await resolveTenantTelegramCredentials(tenantId);
  if (!creds) throw new Error("telegram not configured (cannot download file)");
  const meta = await fetch(`${TG_API_BASE}/bot${creds.botToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!meta.ok) throw new Error(`Telegram getFile failed (${meta.status})`);
  const metaJson = (await meta.json().catch(() => ({}))) as any;
  const filePath = metaJson?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");
  const file = await fetch(`${TG_API_BASE}/file/bot${creds.botToken}/${filePath}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!file.ok) throw new Error(`Telegram file download failed (${file.status})`);
  return Buffer.from(await file.arrayBuffer());
}

// ── Retry + dead-letter (parity with waSender.runWaSendRetries) ─────────────

export interface TgRetryRunResult {
  due: number;
  retried: number;
  resent: number;
  dead: number;
  skipped: number;
}

/**
 * Alert the tenant admin that a Telegram send dead-lettered, via the SAME
 * alert path waSender uses (WhatsApp text to settings.adminPhone). Never
 * throws.
 */
async function sendTelegramDeadLetterAlert(
  row: { tenantId: string; chatId: string; kind: string },
  errorSummary: string,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const [t] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId))
      .limit(1)
      .catch(() => [null as any]);
    const adminPhone = ((t?.settings as Record<string, unknown> | null)?.adminPhone as string | undefined) ?? "";
    if (!adminPhone.trim()) return;
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(
      row.tenantId,
      adminPhone,
      `⚠️ Telegram message dead-lettered after ${WA_RETRY_MAX_ATTEMPTS} attempts.\n` +
        `Chat: ${row.chatId}\nKind: ${row.kind}\nError: ${errorSummary.slice(0, 300)}`,
      { notifType: "telegram_dead_letter_alert" },
    ).catch((e: any) => console.warn("[telegramSender] dead-letter admin alert send failed:", e?.message));
  } catch (e: any) {
    console.warn("[telegramSender] dead-letter admin alert error:", e?.message);
  }
}

/**
 * Retry due failed Telegram sends: telegram_outbox rows with status='failed',
 * nextRetryAt ≤ now and attempts < 4. Backoff reuses WA_RETRY_BACKOFF_MS
 * (1m, 5m, 15m, 1h); a stored Telegram 429 retry_after pushes nextRetryAt
 * further out. Consent-blocked chats (consents ledger, channel 'telegram',
 * keyed by chat_id) and rows without a replayable payload are never retried.
 * Exhausted or permanently-failing sends go status='dead' and the admin is
 * alerted. Fail-open throughout (cron must never crash on this).
 */
export async function runTelegramSendRetries(opts?: { now?: Date; limit?: number }): Promise<TgRetryRunResult> {
  const result: TgRetryRunResult = { due: 0, retried: 0, resent: 0, dead: 0, skipped: 0 };
  const now = opts?.now ?? new Date();
  const db = await getDb();
  if (!db) {
    console.warn("[telegramSender] retry run: DB unavailable");
    return result;
  }
  const rows = await db
    .select()
    .from(telegramOutbox)
    .where(and(
      eq(telegramOutbox.status, "failed"),
      isNotNull(telegramOutbox.nextRetryAt),
      lte(telegramOutbox.nextRetryAt, now),
      lt(telegramOutbox.attempts, WA_RETRY_MAX_ATTEMPTS),
    ))
    .limit(opts?.limit ?? 25)
    .catch((e: any) => {
      console.error("[telegramSender] retry query failed:", e?.message);
      return [] as any[];
    });
  result.due = rows.length;

  for (const row of rows) {
    const clearRetry = async () => {
      await db.update(telegramOutbox)
        .set({ nextRetryAt: null, updatedAt: new Date() })
        .where(eq(telegramOutbox.id, row.id))
        .catch((e: any) => console.warn("[telegramSender] retry clear failed:", e?.message));
    };

    // Never retry consent-blocked recipients — clear the schedule quietly.
    let consent = true;
    try {
      const { getConsent } = await import("./consent");
      const row2 = await getConsent(db, row.tenantId, row.chatId, CONSENT_CHANNEL_TELEGRAM);
      consent = row2?.granted !== false; // no row yet → fail open (prompt flow owns gating)
    } catch {
      consent = true; // consent lookup failure must not stall retries
    }
    if (!consent) {
      await clearRetry();
      result.skipped++;
      continue;
    }

    const payload = row.payload as { method?: string; body?: Record<string, unknown> } | null;
    if (!payload?.method || !payload.body) {
      await clearRetry(); // e.g. buffer media — not replayable
      result.skipped++;
      continue;
    }

    const attempt = (row.attempts ?? 0) + 1;
    const creds = await resolveTenantTelegramCredentials(row.tenantId);
    if (!creds) {
      // Credentials withdrawn/disabled — treat like a transient failure, push back.
      await db.update(telegramOutbox)
        .set({ attempts: attempt, nextRetryAt: new Date(now.getTime() + retryBackoffMs(attempt)), updatedAt: new Date() })
        .where(eq(telegramOutbox.id, row.id))
        .catch(() => {});
      result.retried++;
      continue;
    }

    let httpStatus: number | null = null;
    let errText = "";
    let newMessageId: number | null = null;
    let retryAfterSec: number | null = null;
    try {
      const res = await fetch(`${TG_API_BASE}/bot${creds.botToken}/${payload.method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: row.chatId, ...payload.body }),
        signal: AbortSignal.timeout(12000),
      });
      httpStatus = res.status;
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        newMessageId = typeof data?.result?.message_id === "number" ? data.result.message_id : -1;
      } else {
        errText = await res.text().catch(() => "");
        if (res.status === 429) retryAfterSec = parseTelegramRetryAfter(errText);
      }
    } catch (netErr: any) {
      httpStatus = null;
      errText = String(netErr?.message ?? netErr);
    }

    if (newMessageId !== null) {
      await db.update(telegramOutbox)
        .set({
          status: "sent",
          telegramMessageId: newMessageId >= 0 ? newMessageId : row.telegramMessageId,
          attempts: attempt,
          nextRetryAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(telegramOutbox.id, row.id))
        .catch((e: any) => console.warn("[telegramSender] retry success update failed:", e?.message));
      result.resent++;
      continue;
    }

    const failureClass = classifyTelegramSendError(httpStatus);
    const lastError = `retry ${attempt}: ${httpStatus != null ? `Bot API ${httpStatus}` : "network"}: ${errText.slice(0, 300)}`;
    const isDead = failureClass === "permanent" || attempt >= WA_RETRY_MAX_ATTEMPTS;
    const nextDelay = retryAfterSec
      ? Math.max(retryAfterSec * 1000, retryBackoffMs(attempt))
      : retryBackoffMs(attempt);
    await db.update(telegramOutbox)
      .set({
        status: isDead ? "dead" : "failed",
        attempts: attempt,
        nextRetryAt: isDead ? null : new Date(now.getTime() + nextDelay),
        lastError,
        updatedAt: new Date(),
      })
      .where(eq(telegramOutbox.id, row.id))
      .catch((e: any) => console.warn("[telegramSender] retry failure update failed:", e?.message));
    if (isDead) {
      result.dead++;
      await sendTelegramDeadLetterAlert(
        { tenantId: row.tenantId, chatId: row.chatId, kind: row.kind },
        errText || lastError,
      );
    } else {
      result.retried++;
    }
  }
  return result;
}

/**
 * Honest status snapshot for /health/ready + infra probes: never throws,
 * never touches the network.
 */
export async function getTelegramSenderStatus(tenantId?: string): Promise<{
  channel: "telegram";
  globallyEnabled: boolean;
  configured: boolean;
  mode: "disabled" | "simulation" | "live";
}> {
  const globallyEnabled = telegramEnabled();
  let configured = false;
  if (globallyEnabled && tenantId) {
    configured = (await resolveTenantTelegramCredentials(tenantId)) !== null;
  }
  return {
    channel: "telegram",
    globallyEnabled,
    configured,
    mode: !globallyEnabled ? "disabled" : configured ? "live" : "simulation",
  };
}
// === W37 telegram END ===
