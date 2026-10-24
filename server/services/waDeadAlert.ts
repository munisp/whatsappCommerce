// === W62 findings ===
/**
 * F13 — wa_webhook_events dead-row admin alert (audit W61 LOW #11).
 * Webhook events that exhaust 3 retries went status='dead' and stopped
 * silently. This helper resolves the tenant from the event's
 * phone_number_id and alerts the tenant admin over WhatsApp
 * (settings.adminPhone — the same ops-alert path waSender/telegramSender/
 * emailOutbox use). Fail-open telemetry throughout: alerting must never
 * crash the retry sweep or block the dead-letter transition.
 */
import { eq } from "drizzle-orm";
import { tenants } from "../../drizzle/schema"; // eslint-disable-line @typescript-eslint/no-unused-vars -- kept for parity with sibling alert services

interface WaWebhookEventLike {
  id: string;
  phoneNumberId?: string | null;
  waPhoneNumber?: string | null;
  messageType?: string | null;
  retryCount?: number | null;
}

export async function alertTenantAdminWaWebhookDead(
  db: any,
  evt: WaWebhookEventLike,
  errorSummary: string,
): Promise<boolean> {
  try {
    const { lookupTenantByPhoneNumberId } = await import("./waTenantLookup");
    const tenant = evt.phoneNumberId
      ? await lookupTenantByPhoneNumberId(db, evt.phoneNumberId).catch(() => null)
      : null;
    const tenantId = (tenant as any)?.id as string | undefined;
    if (!tenantId) return false;
    const adminPhone =
      (((tenant as any)?.settings as Record<string, unknown> | null)?.adminPhone as string | undefined) ?? "";
    if (!adminPhone.trim()) return false;
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(
      tenantId,
      adminPhone,
      `⚠️ WhatsApp webhook event dead-lettered after ${evt.retryCount ?? 3} retries.\n` +
        `Type: ${evt.messageType ?? "unknown"} · Number: ${evt.waPhoneNumber ?? "?"} · Event ${evt.id}\n` +
        `Error: ${errorSummary.slice(0, 300)}\n` +
        `Review it in the webhook DLQ dashboard and requeue if needed.`,
      { notifType: "wa_webhook_dead_alert" },
    ).catch((e: any) => console.warn("[waDeadAlert] admin alert send failed:", e?.message));
    return true;
  } catch (e: any) {
    console.warn("[waDeadAlert] alert error:", e?.message);
    return false;
  }
}
// === END W62 findings ===
