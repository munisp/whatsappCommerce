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

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { tenants, whatsappNotificationLog } from "../../drizzle/schema";

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
        const accessToken = typeof wa.accessToken === "string" ? wa.accessToken : "";
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
}

async function logSend(opts: LogSendOpts, outcome: { status: "sent" | "failed" | "simulated"; wamid?: string | null; failReason?: string }): Promise<void> {
  if (opts.skipLog) return;
  try {
    const db = await getDb();
    if (!db) return;
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
      sentAt: outcome.status === "sent" ? new Date() : null,
      failedAt: outcome.status === "failed" ? new Date() : null,
      failReason: outcome.failReason ?? null,
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
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: true, body: chunk },
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[waSender] API error ${res.status}: ${errBody}`);
      await logSend(
        { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, skipLog: opts?.skipLog },
        { status: "failed", failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}` },
      );
      throw new Error(`WhatsApp send failed (${res.status}): ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json().catch(() => ({}))) as any;
    const wamid: string | null = data?.messages?.[0]?.id ?? null;
    if (wamid) wamids.push(wamid);
    await logSend(
      { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, skipLog: opts?.skipLog },
      { status: "sent", wamid },
    );
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
  const res = await fetch(url, {
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

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[waSender] ${logCtx.notifType} API error ${res.status}: ${errBody}`);
    await logSend(logBase, { status: "failed", failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}` });
    throw new Error(`WhatsApp ${logCtx.notifType} send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as any;
  const wamid: string | null = data?.messages?.[0]?.id ?? null;
  await logSend(logBase, { status: "sent", wamid });
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components && components.length > 0 ? { components } : {}),
      },
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[waSender] template API error ${res.status}: ${errBody}`);
    await logSend(
      { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, templateName, skipLog: opts?.skipLog },
      { status: "failed", failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}` },
    );
    throw new Error(`WhatsApp template send failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => ({}))) as any;
  const wamid: string | null = data?.messages?.[0]?.id ?? null;
  await logSend(
    { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId, templateName, skipLog: opts?.skipLog },
    { status: "sent", wamid },
  );
  return { sent: true, simulated: false, wamid };
}
