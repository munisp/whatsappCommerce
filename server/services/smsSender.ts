// === W50 SMS ===
/**
 * SMS Sender Service — Africa's Talking (primary) + Twilio (fallback provider).
 *
 * Mirrors waSender conventions:
 *   - Tenant credentials first (tenants.settings.sms JSON blob, secrets stored
 *     encrypted with the same v1: envelope as settings.whatsapp.accessToken —
 *     decryptSecret passes legacy plaintext through unchanged), then env.
 *       settings.sms = {
 *         provider:  "africa_talking" | "twilio",
 *         // Africa's Talking:
 *         username:  string, apiKey: string (encrypted), senderId?: string,
 *         // Twilio:
 *         sid: string, token: string (encrypted), from?: string,
 *       }
 *   - Env fallback: AFRICASTALKING_USERNAME / AFRICASTALKING_API_KEY /
 *     AFRICASTALKING_SENDER_ID, or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 *     TWILIO_FROM_NUMBER.
 *   - Bounded network I/O via fetchJson (net/resilientFetch): per-attempt
 *     timeout, retriable backoff for 5xx/429/network, circuit breaker.
 *   - Failure classification identical to WA (classifySmsSendError).
 *   - Every attempted send is logged to channel_messages (channel "sms",
 *     direction "outbound") with status/failReason/failureClass metadata.
 *   - Throws on provider failure after logging (same "catch and decide"
 *     contract as waSender); callers that must not block use sendSmsSafe.
 */

import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tenants, channelMessages } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";
import { fetchJson } from "./net/resilientFetch";

export type SmsProvider = "africa_talking" | "twilio";

export interface SmsCredentials {
  provider: SmsProvider;
  /** Africa's Talking username / Twilio Account SID. */
  username: string;
  /** Africa's Talking apiKey / Twilio auth token (decrypted). */
  secret: string;
  /** Sender id (AT alphanumeric shortcode) or From number (Twilio E.164). */
  senderId: string;
  source: "tenant" | "env";
}

/** Tenant settings.sms shape (stored in the tenants.settings JSON blob). */
export interface TenantSmsSettings {
  provider?: string;
  username?: string;   // AT username or Twilio SID
  apiKey?: string;     // AT api key (encrypted v1: or legacy plaintext)
  senderId?: string;   // AT sender id
  sid?: string;        // Twilio Account SID (alias of username)
  token?: string;      // Twilio auth token (encrypted)
  from?: string;       // Twilio From number (alias of senderId)
}

/**
 * Resolve SMS credentials for a tenant. Returns null when neither tenant
 * settings nor env are configured — callers treat that as simulation mode.
 */
export async function resolveTenantSmsCredentials(tenantId: string | null | undefined): Promise<SmsCredentials | null> {
  if (tenantId && tenantId !== "default") {
    try {
      const db = await getDb();
      if (db) {
        const [t] = await db
          .select({ settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const sms = ((((t?.settings as Record<string, unknown> | null)?.sms) ?? {}) as TenantSmsSettings);
        const provider: SmsProvider = sms.provider === "twilio" ? "twilio" : "africa_talking";
        const username = (sms.username ?? sms.sid ?? "").trim();
        const rawSecret = (sms.apiKey ?? sms.token ?? "").trim();
        const secret = rawSecret ? decryptSecret(rawSecret) : "";
        const senderId = (sms.senderId ?? sms.from ?? "").trim();
        if (username && secret) {
          return { provider, username, secret, senderId, source: "tenant" };
        }
      }
    } catch (e: any) {
      // Fall through to env credentials — never block sending on a lookup error.
      console.warn("[smsSender] tenant credential lookup failed:", e?.message);
    }
  }
  // Env fallback: Africa's Talking first, then Twilio.
  const atUser = process.env.AFRICASTALKING_USERNAME || "";
  const atKey = process.env.AFRICASTALKING_API_KEY || "";
  if (atUser && atKey) {
    return { provider: "africa_talking", username: atUser, secret: atKey, senderId: process.env.AFRICASTALKING_SENDER_ID || "", source: "env" };
  }
  const twSid = process.env.TWILIO_ACCOUNT_SID || "";
  const twToken = process.env.TWILIO_AUTH_TOKEN || "";
  if (twSid && twToken) {
    return { provider: "twilio", username: twSid, secret: twToken, senderId: process.env.TWILIO_FROM_NUMBER || "", source: "env" };
  }
  return null;
}

// ── SMS segmentation (GSM-7 / UCS-2) ─────────────────────────────────────────

/** GSM 03.38 basic charset + basic extension (approximated for segmentation). */
const GSM7_RE = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[\]~|€]*$/;

export const SMS_GSM7_SINGLE = 160;
export const SMS_GSM7_CONCAT = 153;
export const SMS_UCS2_SINGLE = 70;
export const SMS_UCS2_CONCAT = 67;
/** Never silently split into more than this many parts — truncate instead. */
export const SMS_MAX_PARTS = 3;

export type SmsEncoding = "gsm7" | "ucs2";

export function smsEncodingFor(text: string): SmsEncoding {
  return GSM7_RE.test(text) ? "gsm7" : "ucs2";
}

export interface SmsChunkResult {
  chunks: string[];
  encoding: SmsEncoding;
  /** True when the body exceeded SMS_MAX_PARTS segments and was truncated. */
  truncated: boolean;
}

/**
 * Split a message into SMS segments: 160 GSM-7 / 70 UCS-2 for a single
 * segment, 153/67 per part for concatenated SMS, capped at SMS_MAX_PARTS
 * parts (overflow truncated with an ellipsis marker, never silently dropped
 * into unbounded multi-part billing). Prefers newline/space breaks.
 */
export function chunkSmsText(body: string, maxParts: number = SMS_MAX_PARTS): SmsChunkResult {
  const encoding = smsEncodingFor(body);
  const single = encoding === "gsm7" ? SMS_GSM7_SINGLE : SMS_UCS2_SINGLE;
  const concat = encoding === "gsm7" ? SMS_GSM7_CONCAT : SMS_UCS2_CONCAT;
  if (body.length <= single) return { chunks: [body], encoding, truncated: false };

  const chunks: string[] = [];
  let remaining = body;
  let truncated = false;
  while (remaining.length > 0) {
    const partsLeft = maxParts - chunks.length;
    const limit = partsLeft > 1 ? concat : concat; // last part also uses concat budget
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    if (partsLeft <= 1) {
      // Final allowed part and it still doesn't fit — truncate honestly.
      chunks.push(`${remaining.slice(0, Math.max(0, limit - 1))}…`);
      truncated = true;
      break;
    }
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  return { chunks, encoding, truncated };
}

/**
 * Strip rich-channel chrome for SMS: emoji/pictographs, markdown emphasis,
 * and media annotations ("[image]", "📎 …") degrade to plain text. Locale
 * pack strings pass through unchanged when they are already plain.
 */
export function stripSmsChrome(text: string): string {
  return text
    // Media annotations → nothing (SMS cannot carry media).
    .replace(/\[(image|photo|video|document|media)[^\]]*\]/gi, "")
    // Emoji / pictographs / symbols outside BMP-safe GSM range (astral
    // planes via surrogate pairs — no `u` flag: repo targets ES5).
    .replace(/([\uD800-\uDBFF][\uDC00-\uDFFF])|[\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u2190-\u21FF\u2300-\u23FF]/g, "")
    // Markdown emphasis markers.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Collapse whitespace runs left by removals.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .trim();
}

// ── Failure classification (mirrors waSender) ────────────────────────────────

export type SmsFailureClass = "retriable" | "permanent";

/**
 * 5xx / 429 / network-level errors are transient and retriable; other 4xx
 * (invalid recipient, bad credentials, insufficient balance) are permanent.
 */
export function classifySmsSendError(httpStatus?: number | null, err?: unknown): SmsFailureClass {
  if (httpStatus == null) return "retriable";
  if (httpStatus === 429 || httpStatus >= 500) return "retriable";
  return "permanent";
}

// ── Provider payload builders (exported for contract tests) ─────────────────

export const AFRICASTALKING_MESSAGES_URL = "https://api.africastalking.com/version1/messaging";

/** Africa's Talking POST /version1/messaging — apiKey header + form body. */
export function buildAfricasTalkingRequest(creds: SmsCredentials, to: string, message: string): {
  url: string; headers: Record<string, string>; body: string;
} {
  const params = new URLSearchParams({ username: creds.username, to, message });
  if (creds.senderId) params.set("from", creds.senderId);
  return {
    url: AFRICASTALKING_MESSAGES_URL,
    headers: {
      apiKey: creds.secret,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  };
}

/** Twilio POST /2010-04-01/Accounts/{sid}/Messages.json — basic auth + form body. */
export function buildTwilioRequest(creds: SmsCredentials, to: string, message: string): {
  url: string; headers: Record<string, string>; body: string;
} {
  const params = new URLSearchParams({ To: to, Body: message });
  params.set("From", creds.senderId || creds.username);
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.username)}/Messages.json`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.secret}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  };
}

export function buildSmsRequest(creds: SmsCredentials, to: string, message: string) {
  return creds.provider === "twilio"
    ? buildTwilioRequest(creds, to, message)
    : buildAfricasTalkingRequest(creds, to, message);
}

// ── Send logging (channel_messages) ──────────────────────────────────────────

interface SmsLogOpts {
  tenantId: string;
  toPhone: string;
  fromAddress: string;
  body: string;
  /** Idempotency key (e.g. WA failover: the whatsapp_notification_log id). */
  idempotencyKey?: string | null;
  skipLog?: boolean;
}

async function logSmsSend(opts: SmsLogOpts, outcome: {
  status: "sent" | "failed" | "simulated";
  provider?: SmsProvider;
  externalId?: string | null;
  parts?: number;
  encoding?: SmsEncoding;
  failReason?: string;
  failureClass?: SmsFailureClass;
}): Promise<string | null> {
  if (opts.skipLog) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const id = crypto.randomUUID();
    await db.insert(channelMessages).values({
      id,
      channel: "sms",
      direction: "outbound",
      fromAddress: opts.fromAddress,
      toAddress: opts.toPhone,
      body: opts.body.slice(0, 4000),
      tenantId: opts.tenantId,
      processed: outcome.status !== "failed",
      metadata: {
        status: outcome.status,
        provider: outcome.provider ?? null,
        externalId: outcome.externalId ?? null,
        parts: outcome.parts ?? 1,
        encoding: outcome.encoding ?? null,
        failReason: outcome.failReason ?? null,
        failureClass: outcome.failureClass ?? null,
        failoverKey: opts.idempotencyKey ?? null,
      },
      createdAt: new Date(),
    });
    return id;
  } catch (e: any) {
    console.warn("[smsSender] channel_messages log insert failed:", e?.message);
    return null;
  }
}

/**
 * True when an SMS with this idempotency key was already logged (sent or
 * simulated) — the WA→SMS failover path uses this to stay idempotent.
 */
export async function smsAlreadySent(tenantId: string, idempotencyKey: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const rows = await db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(and(
        eq(channelMessages.tenantId, tenantId),
        eq(channelMessages.channel, "sms"),
        eq(channelMessages.direction, "outbound"),
        sql`${channelMessages.metadata}->>'failoverKey' = ${idempotencyKey}`,
      ))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false; // fail-open: a dedupe lookup error must not block sending
  }
}

export interface SendSmsResult {
  sent: boolean;
  simulated: boolean;
  provider: SmsProvider | null;
  messageIds: string[];
  parts: number;
  encoding: SmsEncoding;
  truncated: boolean;
}

export interface SendSmsOpts {
  idempotencyKey?: string | null;
  skipLog?: boolean;
  /** Max concatenated parts (default SMS_MAX_PARTS = 3). */
  maxParts?: number;
}

/**
 * Send an SMS as a tenant. Segments the body (160 GSM-7 / 70 UCS-2, up to
 * SMS_MAX_PARTS concatenated parts), sends each part via the configured
 * provider, and logs every attempt to channel_messages.
 *
 * @throws Error on provider failure (after logging) — same contract as
 *         waSender.sendWhatsAppText. When no credentials are configured the
 *         send is simulated and logged with status "simulated".
 */
export async function sendSms(
  tenantId: string,
  toPhone: string,
  body: string,
  opts?: SendSmsOpts,
): Promise<SendSmsResult> {
  const { chunks, encoding, truncated } = chunkSmsText(body, opts?.maxParts);
  const creds = await resolveTenantSmsCredentials(tenantId);
  const fromAddress = creds?.senderId || creds?.username || "sms-sim";

  if (!creds) {
    console.info(
      `[smsSender] SIMULATION (${tenantId}) → *${toPhone.slice(-4)}: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`,
    );
    await logSmsSend(
      { tenantId, toPhone, fromAddress, body, idempotencyKey: opts?.idempotencyKey, skipLog: opts?.skipLog },
      { status: "simulated", parts: chunks.length, encoding },
    );
    return { sent: false, simulated: true, provider: null, messageIds: [], parts: chunks.length, encoding, truncated };
  }

  const messageIds: string[] = [];
  for (const chunk of chunks) {
    const req = buildSmsRequest(creds, toPhone, chunk);
    let res;
    try {
      res = await fetchJson<any>(req.url, {
        integration: `${creds.provider}-sms`,
        timeoutMs: 10000,
        retries: 2,
        backoffMs: 500,
        init: { method: "POST", headers: req.headers, body: req.body },
      });
    } catch (netErr: any) {
      // Network/timeout after bounded retries — retriable, logged, thrown.
      await logSmsSend(
        { tenantId, toPhone, fromAddress, body: chunk, idempotencyKey: opts?.idempotencyKey, skipLog: opts?.skipLog },
        {
          status: "failed", provider: creds.provider, parts: chunks.length, encoding,
          failReason: `network: ${String(netErr?.message ?? netErr).slice(0, 500)}`,
          failureClass: "retriable",
        },
      );
      throw new Error(`SMS send failed (network): ${netErr?.message ?? netErr}`);
    }

    const data = res.data as any;
    // Provider-level rejection: Africa's Talking returns 201 with a
    // per-recipient status; Twilio returns non-2xx with an error envelope.
    const atRecipient = data?.SMSMessageData?.Recipients?.[0];
    const atRejected = creds.provider === "africa_talking" && atRecipient && !/success/i.test(String(atRecipient.status ?? ""));
    if (!res.ok || atRejected) {
      const errText = (res.text ?? JSON.stringify(data ?? {})).slice(0, 500);
      await logSmsSend(
        { tenantId, toPhone, fromAddress, body: chunk, idempotencyKey: opts?.idempotencyKey, skipLog: opts?.skipLog },
        {
          status: "failed", provider: creds.provider, parts: chunks.length, encoding,
          failReason: `${creds.provider} ${res.status}: ${errText}`,
          failureClass: classifySmsSendError(res.ok ? 400 : res.status),
        },
      );
      throw new Error(`SMS send failed (${res.status}): ${errText.slice(0, 200)}`);
    }

    const externalId: string | null =
      creds.provider === "twilio" ? (data?.sid ?? null) : (atRecipient?.messageId ?? data?.SMSMessageData?.Recipients?.[0]?.messageId ?? null);
    if (externalId) messageIds.push(String(externalId));
    await logSmsSend(
      { tenantId, toPhone, fromAddress, body: chunk, idempotencyKey: opts?.idempotencyKey, skipLog: opts?.skipLog },
      { status: "sent", provider: creds.provider, externalId, parts: chunks.length, encoding },
    );
  }

  return { sent: true, simulated: false, provider: creds.provider, messageIds, parts: chunks.length, encoding, truncated };
}

/** Fail-open wrapper: never throws; outcome is in the result. */
export async function sendSmsSafe(
  tenantId: string,
  toPhone: string,
  body: string,
  opts?: SendSmsOpts,
): Promise<SendSmsResult & { error?: string }> {
  try {
    return await sendSms(tenantId, toPhone, body, opts);
  } catch (e: any) {
    console.warn("[smsSender] send failed (fail-open):", e?.message);
    return { sent: false, simulated: false, provider: null, messageIds: [], parts: 0, encoding: "gsm7", truncated: false, error: String(e?.message ?? e) };
  }
}

// === END W50 SMS ===
