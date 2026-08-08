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
}

async function logSend(opts: LogSendOpts, outcome: { status: "sent" | "failed" | "simulated"; wamid?: string | null; failReason?: string }): Promise<void> {
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
      templateName: null,
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
  opts?: { notifType?: string; orderId?: string | null; userId?: number | null },
): Promise<SendTextResult> {
  const notifType = opts?.notifType ?? "conversation_reply";
  const to = normalizeWaPhone(toPhone);
  const chunks = chunkWhatsAppText(body);

  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) {
    console.info(
      `[waSender] SIMULATION (${tenantId}) → *${to.slice(-4)}: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`,
    );
    await logSend({ tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId }, { status: "simulated" });
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
        { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId },
        { status: "failed", failReason: `Graph API ${res.status}: ${errBody.slice(0, 500)}` },
      );
      throw new Error(`WhatsApp send failed (${res.status}): ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json().catch(() => ({}))) as any;
    const wamid: string | null = data?.messages?.[0]?.id ?? null;
    if (wamid) wamids.push(wamid);
    await logSend(
      { tenantId, phone: to, notifType, orderId: opts?.orderId, userId: opts?.userId },
      { status: "sent", wamid },
    );
  }

  return { sent: true, simulated: false, wamids, chunks: chunks.length };
}
