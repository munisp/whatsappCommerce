/**
 * WhatsApp Sender Service
 *
 * Delivers platform-computed conversational replies (and other free-text
 * notifications) to buyers over the WhatsApp Business Cloud API.
 *
 * Credential resolution order:
 *   1. Tenant credentials — tenants.whatsappPhoneNumberId +
 *      settings.whatsapp.accessToken (same storage/masking convention as
 *      routers/tenant.ts getWhatsAppConfig; the token is stored in the
 *      tenant settings JSON blob and never logged).
 *   2. Global env fallback — WAC_WHATSAPP_TOKEN / WAC_WHATSAPP_PHONE_ID
 *      (then WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID), matching
 *      routers/whatsappNotifications.ts.
 *
 * Behaviour:
 *   - Messages longer than WA_TEXT_LIMIT are split into sequential chunks.
 *   - Every attempted send is logged to whatsapp_notification_log
 *     (status sent / failed / simulated) so delivery receipts can
 *     cross-reference the returned wamid.
 *   - Throws on a non-200 Graph API response so callers can decide whether
 *     to retry; callers that must not block should .catch() and log.
 */

import { and, eq, isNotNull, lte, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tenants, whatsappNotificationLog } from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";

/** Metering imports waSender (alert sends) — lazy import avoids the cycle. */
async function meterFailedSend(db: WaDb, tenantId: string): Promise<void> {
  try {
    const { recordUsage } = await import("./metering");
    await recordUsage(db, tenantId, METRIC_WA_MESSAGES_FAILED).catch(() => null);
  } catch {
    /* metering must never block sending */
  }
}

/** WhatsApp Cloud API text body limit is 4096; chunk earlier for safety. */
export const WA_TEXT_LIMIT = 4000;

export interface WaCredentials {
  phoneNumberId: string;
  accessToken: string;
  source: "tenant" | "env";
}

export interface SendTextResult {
  sent: boolean;
  simulated: boolean;
  wamids: string[];
  chunks: number;
}

/**
 * Resolve the WhatsApp sender credentials for a tenant.
 * Returns null when neither tenant nor env credentials are configured —
 * callers should treat that as simulation mode.
 */
export async function resolveTenantWaCredentials(tenantId: string | null | undefined): Promise<WaCredentials | null> {
  if (tenantId && tenantId !== "default") {
    try {
      const db = await getDb();
      if (db) {
        const [t] = await db
          .select({ phoneNumberId: tenants.whatsappPhoneNumberId, settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        const wa = (((t?.settings as Record<string, unknown> | null)?.whatsapp ?? {}) as Record<string, unknown>);
        // Stored encrypted (v1:) since w10 — decryptSecret passes legacy
        // plaintext through unchanged.
        const rawToken = typeof wa.accessToken === "string" ? wa.accessToken : "";
        const accessToken = rawToken ? decryptSecret(rawToken) : "";
        if (t?.phoneNumberId && accessToken) {
          return { phoneNumberId: t.phoneNumberId, accessToken, source: "tenant" };
        }
      }
    } catch (e: any) {
      // Fall through to env credentials — never block sending on a lookup error.
      console.warn("[waSender] tenant credential lookup failed:", e?.message);
    }
  }
  const accessToken = process.env.WAC_WHATSAPP_TOKEN || process.env.WHATSAPP_TOKEN || "";
  const phoneNumberId = process.env.WAC_WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || "";
  if (accessToken && phoneNumberId) return { phoneNumberId, accessToken, source: "env" };
  return null;
}

/**
 * Split a message into chunks of at most `limit` characters, preferring to
 * break on newlines/spaces so chunks stay readable.
 */
export function chunkWhatsAppText(body: string, limit: number = WA_TEXT_LIMIT): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** Normalize to the digits-only format the Cloud API expects for `to`. */
export function normalizeWaPhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

// ── Send retry classification ───────────────────────────────────────────────

export type WaFailureClass = "retriable" | "permanent";

/** Exponential backoff between retry attempts: 1m, 5m, 15m, 1h. */
export const WA_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
/** After this many failed attempts a send is dead-lettered (status "dead"). */
export const WA_RETRY_MAX_ATTEMPTS = 4;

/**
 * Classify a failed send: 5xx / 429 / network-level errors are transient and
 * retriable; other 4xx (template rejected, recipient invalid, etc.) are
 * permanent and must never be retried.
 */
export function classifyWaSendError(httpStatus?: number | null, err?: unknown): WaFailureClass {
  if (httpStatus == null) return "retriable"; // network/timeout/abort
  if (httpStatus === 429 || httpStatus >= 500) return "retriable";
  return "permanent";
}

/** Next retry delay (ms) after `attempts` failed attempts (1-based). */
export function retryBackoffMs(attempts: number): number {
  return WA_RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), WA_RETRY_BACKOFF_MS.length - 1)];
}

interface LogSendOpts {
  tenantId: string;
  phone: string;
  notifType: string;
  orderId?: string | null;
  userId?: number | null;
  templateName?: string | null;
  /** Set by callers that manage their own log rows (e.g. order notifications)
   *  so a send is not double-logged. */
  skipLog?: boolean;
  /** Outbound Graph payload snapshot (inner payload: type/text/interactive/…)
   *  persisted so a failed send can be retried verbatim. */
  payload?: Record<string, unknown> | null;
}

async function logSend(opts: LogSendOpts, outcome: {
  status: "sent" | "failed" | "simulated";
  wamid?: string | null;
  failReason?: string;
  /** Full error payload text (Graph response body or network error). */
  errorText?: string | null;
  /** Failure classification — retriable failures get a nextRetryAt. */
  failureClass?: WaFailureClass;
}): Promise<void> {
  if (opts.skipLog) return;
  try {
    const db = await getDb();
    if (!db) return;
    const now = new Date();
    const retriable = outcome.status === "failed" && (outcome.failureClass ?? "permanent") === "retriable";
    await db.insert(whatsappNotificationLog).values({
      id: crypto.randomUUID(),
      userId: opts.userId ?? null,
      orderId: opts.orderId ?? null,
      tenantId: opts.tenantId,
      phone: opts.phone,
      notifType: opts.notifType,
      templateName: opts.templateName ?? null,
      status: outcome.status,
      wamid: outcome.wamid ?? null,
      sentAt: outcome.status === "sent" ? now : null,
      failedAt: outcome.status === "failed" ? now : null,
      failReason: outcome.failReason ?? null,
      errorText: outcome.errorText ?? null,
      payload: opts.payload ?? null,
      attempts: outcome.status === "failed" ? 1 : 0,
      nextRetryAt: retriable ? new Date(now.getTime() + retryBackoffMs(1)) : null,
      statusTimestamps: outcome.status === "sent" ? { sent: now.toISOString() } : null,
    });
  } catch (e: any) {
    console.warn("[waSender] notification log insert failed:", e?.message);
  }
}

/**
 * Send a free-text WhatsApp message to a phone number as a tenant.
 *
 * @param tenantId  tenant whose WA credentials should be used (env fallback)
 * @param toPhone   recipient in E.164 or digits-only format
 * @param body      message text (chunked automatically when > WA_TEXT_LIMIT)
 * @param opts      logging metadata: notifType (default "conversation_reply"), orderId, userId
 *
 * @throws Error when the Graph API returns a non-OK status (after logging).
 *         When no credentials are configured the send is simulated: the
 *         message is logged with status "simulated" and no exception is thrown.
 */
export async function sendWhatsAppText(
  tenantId: string,
  toPhone: string,
  body: string,
  opts?: { notifType?: string; orderId?: string | null; userId?: number | null; skipLog?: boolean },
): Promise<SendTextResult> {
  const notifType = opts?.notifType ?? "conversation_reply";
  const to = normalizeWaPhone(toPhone);
  const chunks = chunkWhatsAppText(body);

  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) {
    console.info(
      `[waSender] SIMULATION (${tenantId}) → *${to.slice(-4)}: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`,
    );
    await logSend({ tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, skipLog: opts?.skipLog }, { status: "simulated" });
    return { sent: false, simulated: true, wamids: [], chunks: chunks.length };
  }

  const wamids: string[] = [];
  for (const chunk of chunks) {
    const url = `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`;
    const chunkPayload: Record<string, unknown> = { type: "text", text: { preview_url: true, body: chunk } };
    const logBase = { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, skipLog: opts?.skipLog, payload: chunkPayload };
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...chunkPayload,
        }),
        signal: AbortSignal.timeout(12000),
      });
    } catch (netErr: any) {
      console.error(`[waSender] network error:`, netErr?.message);
      await logSend(logBase, {
        status: "failed",
        failReason: `network: ${String(netErr?.message ?? netErr).slice(0, 500)}`,
        errorText: String(netErr?.message ?? netErr).slice(0, 1000),
        failureClass: "retriable",
      });
      throw new Error(`WhatsApp send failed (network): ${netErr?.message ?? netErr}`);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[waSender] API error ${res.status}: ${errBody}`);
      await logSend(logBase, {
        status: "failed",
        failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}`,
        errorText: errBody.slice(0, 1000),
        failureClass: classifyWaSendError(res.status),
      });
      throw new Error(`WhatsApp send failed (${res.status}): ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json().catch(() => ({}))) as any;
    const wamid: string | null = data?.messages?.[0]?.id ?? null;
    if (wamid) wamids.push(wamid);
    await logSend(logBase, { status: "sent", wamid });
  }

  return { sent: true, simulated: false, wamids, chunks: chunks.length };
}

export interface SendTemplateResult {
  sent: boolean;
  simulated: boolean;
  wamid: string | null;
}

// ── Interactive messages (buttons / lists) ──────────────────────────────────

/** Cloud API hard limits for interactive payloads. */
export const WA_BUTTONS_MAX = 3;
export const WA_BUTTON_TITLE_LIMIT = 20;
export const WA_LIST_ROWS_MAX = 10; // per section
export const WA_LIST_ROW_TITLE_LIMIT = 24;
export const WA_LIST_BUTTON_LABEL_LIMIT = 20;
export const WA_HEADER_TEXT_LIMIT = 60;
export const WA_FOOTER_TEXT_LIMIT = 60;
export const WA_INTERACTIVE_BODY_LIMIT = 1024;

export interface WaInteractiveButton {
  id: string;
  title: string;
}

export interface WaInteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WaInteractiveListSection {
  title?: string;
  rows: WaInteractiveListRow[];
}

export type WaInteractiveAction =
  | { type: "button"; buttons: WaInteractiveButton[] }
  | { type: "list"; buttonLabel?: string; sections: WaInteractiveListSection[] };

export interface SendInteractiveInput {
  headerText?: string;
  bodyText: string;
  footerText?: string;
  action: WaInteractiveAction;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

/**
 * Build the Cloud API `interactive` object for a button or list message,
 * enforcing the platform caps: ≤3 reply buttons, ≤10 rows per list section.
 * Over-long titles are truncated; exceeding a COUNT cap throws (caller bug).
 */
export function buildInteractivePayload(input: SendInteractiveInput): Record<string, unknown> {
  if (!input.bodyText?.trim()) throw new Error("interactive message requires bodyText");
  const interactive: Record<string, unknown> = {
    type: input.action.type,
    body: { text: truncate(input.bodyText, WA_INTERACTIVE_BODY_LIMIT) },
  };
  if (input.headerText?.trim()) {
    interactive.header = { type: "text", text: truncate(input.headerText.trim(), WA_HEADER_TEXT_LIMIT) };
  }
  if (input.footerText?.trim()) {
    interactive.footer = { text: truncate(input.footerText.trim(), WA_FOOTER_TEXT_LIMIT) };
  }
  if (input.action.type === "button") {
    const buttons = input.action.buttons ?? [];
    if (buttons.length === 0) throw new Error("button interactive message requires at least 1 button");
    if (buttons.length > WA_BUTTONS_MAX) {
      throw new Error(`button interactive message supports at most ${WA_BUTTONS_MAX} buttons (got ${buttons.length})`);
    }
    interactive.action = {
      buttons: buttons.map((b) => {
        if (!b.id?.trim()) throw new Error("interactive button requires a non-empty id");
        return { type: "reply", reply: { id: b.id, title: truncate(b.title.trim() || b.id, WA_BUTTON_TITLE_LIMIT) } };
      }),
    };
  } else {
    const sections = input.action.sections ?? [];
    if (sections.length === 0) throw new Error("list interactive message requires at least 1 section");
    interactive.action = {
      button: truncate(input.action.buttonLabel?.trim() || "Choose", WA_LIST_BUTTON_LABEL_LIMIT),
      sections: sections.map((s) => {
        const rows = s.rows ?? [];
        if (rows.length === 0) throw new Error("list section requires at least 1 row");
        if (rows.length > WA_LIST_ROWS_MAX) {
          throw new Error(`list section supports at most ${WA_LIST_ROWS_MAX} rows (got ${rows.length})`);
        }
        return {
          ...(s.title?.trim() ? { title: truncate(s.title.trim(), WA_LIST_ROW_TITLE_LIMIT) } : {}),
          rows: rows.map((r) => {
            if (!r.id?.trim()) throw new Error("list row requires a non-empty id");
            return {
              id: r.id,
              title: truncate(r.title.trim() || r.id, WA_LIST_ROW_TITLE_LIMIT),
              ...(r.description?.trim() ? { description: truncate(r.description.trim(), 72) } : {}),
            };
          }),
        };
      }),
    };
  }
  return interactive;
}

// ── Media messages (image / document) ───────────────────────────────────────

export interface SendMediaInput {
  type: "image" | "document";
  /** Public URL of the media — XOR with mediaId. */
  link?: string;
  /** Previously uploaded Cloud API media id — XOR with link. */
  mediaId?: string;
  caption?: string;
  /** Documents only: the filename shown to the recipient. */
  filename?: string;
}

/** Build the Cloud API media object ({ link | id, caption?, filename? }). */
export function buildMediaPayload(input: SendMediaInput): Record<string, unknown> {
  if (input.type !== "image" && input.type !== "document") {
    throw new Error(`unsupported media type: ${(input as SendMediaInput).type}`);
  }
  const hasLink = !!input.link?.trim();
  const hasId = !!input.mediaId?.trim();
  if (hasLink === hasId) throw new Error("media message requires exactly one of link or mediaId");
  const media: Record<string, unknown> = hasLink ? { link: input.link!.trim() } : { id: input.mediaId!.trim() };
  if (input.caption?.trim()) media.caption = truncate(input.caption.trim(), WA_INTERACTIVE_BODY_LIMIT);
  if (input.type === "document" && input.filename?.trim()) media.filename = input.filename.trim();
  return media;
}

interface SendOpts {
  notifType?: string;
  orderId?: string | null;
  userId?: number | null;
  skipLog?: boolean;
}

/**
 * Shared single-payload delivery for interactive + media senders: same
 * credential resolution, notification logging and error behaviour as
 * sendWhatsAppText (simulation when unconfigured, throw on non-OK Graph API).
 */
async function deliverWaPayload(
  tenantId: string,
  toPhone: string,
  payload: Record<string, unknown>,
  logCtx: { notifType: string; simulationNote: string },
  opts?: SendOpts,
): Promise<SendTemplateResult> {
  const to = normalizeWaPhone(toPhone);
  const creds = await resolveTenantWaCredentials(tenantId);
  const logBase = { tenantId, phone: to, notifType: logCtx.notifType, orderId: opts?.orderId, userId: opts?.userId, skipLog: opts?.skipLog };
  if (!creds) {
    console.info(`[waSender] SIMULATION ${logCtx.simulationNote} (${tenantId}) → *${to.slice(-4)}`);
    await logSend(logBase, { status: "simulated" });
    return { sent: false, simulated: true, wamid: null };
  }

  const url = `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...payload,
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (netErr: any) {
    // Network/timeout — transient, always retriable.
    console.error(`[waSender] ${logCtx.notifType} network error:`, netErr?.message);
    await logSend({ ...logBase, payload }, {
      status: "failed",
      failReason: `network: ${String(netErr?.message ?? netErr).slice(0, 500)}`,
      errorText: String(netErr?.message ?? netErr).slice(0, 1000),
      failureClass: "retriable",
    });
    throw new Error(`WhatsApp ${logCtx.notifType} send failed (network): ${netErr?.message ?? netErr}`);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[waSender] ${logCtx.notifType} API error ${res.status}: ${errBody}`);
    await logSend({ ...logBase, payload }, {
      status: "failed",
      failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}`,
      errorText: errBody.slice(0, 1000),
      failureClass: classifyWaSendError(res.status),
    });
    throw new Error(`WhatsApp ${logCtx.notifType} send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as any;
  const wamid: string | null = data?.messages?.[0]?.id ?? null;
  await logSend({ ...logBase, payload }, { status: "sent", wamid });
  return { sent: true, simulated: false, wamid };
}

/**
 * Send an interactive WhatsApp message — reply buttons (≤3) or an option
 * list (≤10 rows per section). Same credentials/logging/error behaviour as
 * sendWhatsAppText.
 */
export async function sendWhatsAppInteractive(
  tenantId: string,
  toPhone: string,
  input: SendInteractiveInput,
  opts?: SendOpts,
): Promise<SendTemplateResult> {
  const interactive = buildInteractivePayload(input);
  return deliverWaPayload(
    tenantId,
    toPhone,
    { type: "interactive", interactive },
    { notifType: opts?.notifType ?? "interactive_message", simulationNote: `interactive:${input.action.type}` },
    opts,
  );
}

/**
 * Send a WhatsApp media message (image or document) by public link or by a
 * previously uploaded media id — closes the outbound media gap.
 */
export async function sendWhatsAppMedia(
  tenantId: string,
  toPhone: string,
  input: SendMediaInput,
  opts?: SendOpts,
): Promise<SendTemplateResult> {
  const media = buildMediaPayload(input);
  return deliverWaPayload(
    tenantId,
    toPhone,
    { type: input.type, [input.type]: media },
    { notifType: opts?.notifType ?? "media_message", simulationNote: `media:${input.type}` },
    opts,
  );
}

/**
 * Send a WhatsApp *template* message (required outside the 24h customer
 * service window) using the same per-tenant credential resolution as
 * sendWhatsAppText: tenants.whatsappPhoneNumberId +
 * settings.whatsapp.accessToken, falling back to env credentials.
 *
 * @param tenantId     tenant whose WA credentials should be used (env fallback)
 * @param toPhone      recipient in E.164 or digits-only format
 * @param templateName approved template name (e.g. "wac_order_confirmation")
 * @param languageCode BCP-47 template language (e.g. "en_US")
 * @param components   Cloud API template components (body/header params)
 * @param opts         logging metadata: notifType, orderId, userId, skipLog
 *
 * @throws Error when the Graph API returns a non-OK status (after logging).
 *         When no credentials are configured the send is simulated: logged
 *         with status "simulated" and no exception is thrown.
 */
export async function sendWhatsAppTemplate(
  tenantId: string,
  toPhone: string,
  templateName: string,
  languageCode: string,
  components?: unknown[],
  opts?: { notifType?: string; orderId?: string | null; userId?: number | null; skipLog?: boolean },
): Promise<SendTemplateResult> {
  const notifType = opts?.notifType ?? "template_message";
  const to = normalizeWaPhone(toPhone);

  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) {
    console.info(
      `[waSender] SIMULATION template (${tenantId}) ${templateName} → *${to.slice(-4)}`,
    );
    await logSend(
      { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, templateName, skipLog: opts?.skipLog },
      { status: "simulated" },
    );
    return { sent: false, simulated: true, wamid: null };
  }

  const url = `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`;
  const templatePayload: Record<string, unknown> = {
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components && components.length > 0 ? { components } : {}),
    },
  };
  const logBase = { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, templateName, skipLog: opts?.skipLog, payload: templatePayload };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...templatePayload,
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (netErr: any) {
    console.error(`[waSender] template network error:`, netErr?.message);
    await logSend(logBase, {
      status: "failed",
      failReason: `network: ${String(netErr?.message ?? netErr).slice(0, 500)}`,
      errorText: String(netErr?.message ?? netErr).slice(0, 1000),
      failureClass: "retriable",
    });
    throw new Error(`WhatsApp template send failed (network): ${netErr?.message ?? netErr}`);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[waSender] template API error ${res.status}: ${errBody}`);
    await logSend(logBase, {
      status: "failed",
      failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}`,
      errorText: errBody.slice(0, 1000),
      failureClass: classifyWaSendError(res.status),
    });
    throw new Error(`WhatsApp template send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as any;
  const wamid: string | null = data?.messages?.[0]?.id ?? null;
  await logSend(logBase, { status: "sent", wamid });
  return { sent: true, simulated: false, wamid };
}

// ── Delivery/read status pipeline ───────────────────────────────────────────

/** Metering metric for failed outbound sends (delivery receipts + retries). */
export const METRIC_WA_MESSAGES_FAILED = "wa.messages.failed";

export interface WaStatusEntry {
  /** wamid of the original outbound send. */
  id?: string;
  status?: string;
  /** Unix epoch seconds, as string. */
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: unknown; title?: string; message?: string }>;
}

type WaDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Apply a Meta `statuses[]` webhook entry to whatsapp_notification_log,
 * keyed by the wamid returned on send. Unknown wamids (messages not sent by
 * this platform) are ignored quietly — returns false. Failed deliveries keep
 * the full error payload in errorText and are metered.
 */
export async function applyWaDeliveryStatus(db: WaDb, tenantId: string, st: WaStatusEntry): Promise<boolean> {
  const wamid = st?.id ?? "";
  const status = st?.status ?? "";
  if (!wamid || !["sent", "delivered", "read", "failed"].includes(status)) return false;
  const tsUnix = parseInt(st.timestamp ?? "0", 10);
  const ts = tsUnix ? new Date(tsUnix * 1000) : new Date();
  const iso = ts.toISOString();
  const errPayload = status === "failed" && st.errors?.length ? JSON.stringify(st.errors).slice(0, 2000) : null;
  const errSummary = status === "failed"
    ? (st.errors?.[0]?.title ?? st.errors?.[0]?.message ?? String(st.errors?.[0]?.code ?? "Unknown error"))
    : null;
  const updated = await db
    .update(whatsappNotificationLog)
    .set({
      status: status as "sent" | "delivered" | "read" | "failed",
      sentAt: status === "sent" ? ts : undefined,
      deliveredAt: status === "delivered" ? ts : undefined,
      readAt: status === "read" ? ts : undefined,
      failedAt: status === "failed" ? ts : undefined,
      failReason: status === "failed" ? errSummary : undefined,
      errorText: status === "failed" ? errPayload : undefined,
      // Merge the per-status timestamp into the jsonb map without a read.
      statusTimestamps: sql`COALESCE(${whatsappNotificationLog.statusTimestamps}, '{}'::jsonb) || ${JSON.stringify({ [status]: iso })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(whatsappNotificationLog.wamid, wamid))
    .returning({ id: whatsappNotificationLog.id })
    .catch((e: any) => {
      console.warn("[waSender] notif log status update failed:", e?.message);
      return [] as Array<{ id: string }>;
    });
  if (!updated.length) return false; // unknown wamid — ignore quietly
  if (status === "failed") {
    await meterFailedSend(db, tenantId);
  }
  return true;
}

// ── Read receipts ───────────────────────────────────────────────────────────

/**
 * Mark an inbound message as read (blue ticks) using the tenant's Cloud API
 * credentials. Fire-and-forget by contract: NEVER throws, NEVER blocks
 * inbound processing — returns false on any failure.
 */
export async function markMessageRead(tenantId: string, wamid: string): Promise<boolean> {
  try {
    if (!wamid) return false;
    const creds = await resolveTenantWaCredentials(tenantId);
    if (!creds) {
      console.info(`[waSender] SIMULATION read receipt (${tenantId}) ${wamid}`);
      return false;
    }
    const res = await fetch(`https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: wamid,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[waSender] read receipt failed ${res.status}: ${errBody.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn("[waSender] read receipt error:", e?.message);
    return false;
  }
}

// ── Location request sender ─────────────────────────────────────────────────

/**
 * Ask the buyer to share their location via the Cloud API interactive
 * `location_request_message` type (action name "send_location"). Same
 * credentials / logging / retry-classified failure path as the other senders.
 */
export async function sendWhatsAppLocationRequest(
  tenantId: string,
  toPhone: string,
  bodyText: string,
  opts?: SendOpts,
): Promise<SendTemplateResult> {
  const interactive: Record<string, unknown> = {
    type: "location_request_message",
    body: { text: truncate(bodyText?.trim() || "Please share your delivery location", WA_INTERACTIVE_BODY_LIMIT) },
    action: { name: "send_location" },
  };
  return deliverWaPayload(
    tenantId,
    toPhone,
    { type: "interactive", interactive },
    { notifType: opts?.notifType ?? "location_request", simulationNote: "interactive:location_request" },
    opts,
  );
}

// ── Send retry + dead-letter ────────────────────────────────────────────────

export interface WaRetryRunResult {
  /** Rows due for a retry in this run. */
  due: number;
  /** Re-delivery attempted (still failing). */
  retried: number;
  /** Re-delivery succeeded (status → sent). */
  resent: number;
  /** Exhausted attempts → status "dead", admin alerted. */
  dead: number;
  /** Not retried: consent-blocked or missing payload (retry cleared). */
  skipped: number;
}

/**
 * Alert the tenant admin (settings.adminPhone) that a send dead-lettered.
 * Never throws — alerting must not fail the retry run.
 */
async function sendDeadLetterAlert(row: { tenantId: string; phone: string; notifType: string }, errorSummary: string): Promise<void> {
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
    await sendWhatsAppText(
      row.tenantId,
      adminPhone,
      `⚠️ WhatsApp message dead-lettered after ${WA_RETRY_MAX_ATTEMPTS} attempts.\n` +
        `Recipient: ${row.phone}\nType: ${row.notifType}\nError: ${errorSummary.slice(0, 300)}`,
      { notifType: "wa_dead_letter_alert" },
    ).catch((e: any) => console.warn("[waSender] dead-letter admin alert send failed:", e?.message));
  } catch (e: any) {
    console.warn("[waSender] dead-letter admin alert error:", e?.message);
  }
}

/**
 * Retry due failed sends: rows in whatsapp_notification_log with
 * status='failed', a scheduled nextRetryAt ≤ now and attempts < 4. Backoff
 * follows WA_RETRY_BACKOFF_MS (1m, 5m, 15m, 1h). Consent-blocked recipients
 * and rows without a stored payload are never retried. Exhausted or
 * permanently-failing sends are dead-lettered and the tenant admin alerted.
 */
export async function runWaSendRetries(opts?: { now?: Date; limit?: number }): Promise<WaRetryRunResult> {
  const result: WaRetryRunResult = { due: 0, retried: 0, resent: 0, dead: 0, skipped: 0 };
  const now = opts?.now ?? new Date();
  const db = await getDb();
  if (!db) {
    console.warn("[waSender] retry run: DB unavailable");
    return result;
  }
  const rows = await db
    .select()
    .from(whatsappNotificationLog)
    .where(and(
      eq(whatsappNotificationLog.status, "failed"),
      isNotNull(whatsappNotificationLog.nextRetryAt),
      lte(whatsappNotificationLog.nextRetryAt, now),
      lt(whatsappNotificationLog.attempts, WA_RETRY_MAX_ATTEMPTS),
    ))
    .limit(opts?.limit ?? 25)
    .catch((e: any) => {
      console.error("[waSender] retry query failed:", e?.message);
      return [] as any[];
    });
  result.due = rows.length;

  for (const row of rows) {
    const clearRetry = async () => {
      await db.update(whatsappNotificationLog)
        .set({ nextRetryAt: null, updatedAt: new Date() })
        .where(eq(whatsappNotificationLog.id, row.id))
        .catch((e: any) => console.warn("[waSender] retry clear failed:", e?.message));
    };

    // Never retry consent-blocked recipients — clear the schedule quietly.
    let consent = true;
    try {
      const { hasConsent } = await import("./consent");
      consent = await hasConsent(row.tenantId, row.phone);
    } catch {
      consent = true; // consent lookup failure must not stall retries
    }
    if (!consent) {
      await clearRetry();
      result.skipped++;
      continue;
    }

    const payload = row.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.type !== "string") {
      // Nothing to replay (e.g. pre-retry-era log rows) — stop scheduling.
      await clearRetry();
      result.skipped++;
      continue;
    }

    const attempt = (row.attempts ?? 0) + 1;
    const creds = await resolveTenantWaCredentials(row.tenantId);
    if (!creds) {
      // Credentials withdrawn — treat like a transient failure, push back.
      await db.update(whatsappNotificationLog)
        .set({ attempts: attempt, nextRetryAt: new Date(now.getTime() + retryBackoffMs(attempt)), updatedAt: new Date() })
        .where(eq(whatsappNotificationLog.id, row.id))
        .catch(() => {});
      result.retried++;
      continue;
    }

    let httpStatus: number | null = null;
    let errText = "";
    let newWamid: string | null = null;
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: row.phone,
          ...payload,
        }),
        signal: AbortSignal.timeout(12000),
      });
      httpStatus = res.status;
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        newWamid = data?.messages?.[0]?.id ?? null;
      } else {
        errText = await res.text().catch(() => "");
      }
    } catch (netErr: any) {
      httpStatus = null;
      errText = String(netErr?.message ?? netErr);
    }

    if (newWamid !== null || httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
      await db.update(whatsappNotificationLog)
        .set({
          status: "sent",
          wamid: newWamid ?? row.wamid,
          sentAt: new Date(),
          attempts: attempt,
          nextRetryAt: null,
          failReason: null,
          errorText: null,
          updatedAt: new Date(),
        })
        .where(eq(whatsappNotificationLog.id, row.id))
        .catch((e: any) => console.warn("[waSender] retry success update failed:", e?.message));
      result.resent++;
      continue;
    }

    const failureClass = classifyWaSendError(httpStatus);
    const failReason = `retry ${attempt}: ${httpStatus != null ? `Graph API ${httpStatus}` : "network"}: ${errText.slice(0, 300)}`;
    const isDead = failureClass === "permanent" || attempt >= WA_RETRY_MAX_ATTEMPTS;
    await db.update(whatsappNotificationLog)
      .set({
        status: isDead ? "dead" : "failed",
        attempts: attempt,
        nextRetryAt: isDead ? null : new Date(now.getTime() + retryBackoffMs(attempt)),
        failedAt: new Date(),
        failReason,
        errorText: errText.slice(0, 1000) || null,
        updatedAt: new Date(),
      })
      .where(eq(whatsappNotificationLog.id, row.id))
      .catch((e: any) => console.warn("[waSender] retry failure update failed:", e?.message));
    await meterFailedSend(db, row.tenantId);
    if (isDead) {
      result.dead++;
      await sendDeadLetterAlert(
        { tenantId: row.tenantId, phone: row.phone, notifType: row.notifType },
        errText || failReason,
      );
    } else {
      result.retried++;
    }
  }
  return result;
}
