/**
 * server/services/waLocation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Native WhatsApp location-request message (interactive
 * `location_request_message`). Sent at the delivery-address step of checkout
 * so buyers can share a pin instead of typing a free-text address. The
 * free-text fallback stays intact — the buyer may simply ignore the request
 * and type the address.
 *
 * NOTE: `sendWhatsAppLocationRequest` is planned to land in waSender.ts via
 * a parallel change; until then this module owns the Graph POST directly,
 * reusing `resolveTenantWaCredentials` from waSender (zero waSender.ts edit).
 * When waSender exports the same function, this wrapper keeps working —
 * callers depend on this module, not on where the POST lives.
 */

import { resolveTenantWaCredentials, normalizeWaPhone } from "./waSender";

export interface LocationRequestResult {
  sent: boolean;
  simulated: boolean;
  wamid?: string | null;
}

/**
 * Send an interactive location-request message.
 * Never throws on Graph errors — returns { sent: false } so the checkout
 * flow always continues with the free-text fallback.
 */
export async function sendWhatsAppLocationRequest(
  tenantId: string,
  toPhone: string,
  bodyText: string,
): Promise<LocationRequestResult> {
  try {
    const creds = await resolveTenantWaCredentials(tenantId);
    if (!creds) {
      console.info(`[waLocation] simulated location request → ${toPhone}: ${bodyText.slice(0, 80)}`);
      return { sent: false, simulated: true };
    }
    const resp = await fetch(`https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizeWaPhone(toPhone),
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: { text: bodyText.slice(0, 1024) },
          action: { name: "send_location" },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(`[waLocation] Graph API ${resp.status}: ${detail.slice(0, 300)}`);
      return { sent: false, simulated: false };
    }
    const json: any = await resp.json().catch(() => null);
    return { sent: true, simulated: false, wamid: json?.messages?.[0]?.id ?? null };
  } catch (e: any) {
    console.error("[waLocation] send failed:", e?.message);
    return { sent: false, simulated: false };
  }
}
