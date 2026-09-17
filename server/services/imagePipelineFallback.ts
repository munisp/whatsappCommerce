// === W45 messaging-services (Coder A2) ===
/**
 * imagePipelineFallback.ts — fail-soft reply for failed inbound image
 * pipelines (MSG-24).
 *
 * The webhook's non-receipt image chain (visual search / catalog AI /
 * expense OCR / vendor bills / stocktake / POD) used to end in a bare
 * `.catch(console.error)` — the customer got SILENCE when their photo
 * crashed a pipeline. This helper delivers the localized
 * "couldn't process that photo" reply on BOTH channels (WhatsApp +
 * Telegram) via the channel-parity router.
 *
 * Fire-and-forget by contract: NEVER throws — the terminal catch of the
 * pipeline must not itself fail.
 *
 * Intended call site (A1 owns server/_core/index.ts): the media branch's
 * async chain currently ends with
 *
 *   .catch((e: any) => console.error("[whatsapp-webhook] receipt verify error:", e?.message));
 *
 * Replace that terminal catch (and the inner visual-search catch) with:
 *
 *   .catch((e: any) => {
 *     console.error("[whatsapp-webhook] receipt verify error:", e?.message);
 *     void replyImagePipelineFailed(tenantId, waPhoneNumber);
 *   });
 */

import { getStickyLocale, tr } from "./i18n";

/**
 * Send the localized "couldn't process that photo" reply. Channel-parity:
 * Telegram chat refs (`telegram:<chat_id>`) route via notifyCustomer;
 * WhatsApp falls through to sendWhatsAppText. Returns true when a send was
 * attempted on some channel; false when nothing could be delivered.
 */
export async function replyImagePipelineFailed(
  tenantId: string,
  phone: string,
): Promise<boolean> {
  try {
    if (!tenantId || !phone) return false;
    const locale = await getStickyLocale(tenantId, phone).catch(() => null);
    const body = tr(locale, "imageProcessingFailed");
    try {
      const { notifyCustomer } = await import("./channelParity");
      const routed = await notifyCustomer(tenantId, phone, "image_pipeline_failed", {
        text: body,
        notifType: "image_pipeline_failed",
      });
      if (routed.handled) return true;
    } catch { /* fall through to WhatsApp */ }
    const { sendWhatsAppText } = await import("./waSender");
    await sendWhatsAppText(tenantId, phone, body, { notifType: "image_pipeline_failed" });
    return true;
  } catch (e: any) {
    console.warn("[imagePipelineFallback] fail-soft reply failed:", e?.message);
    return false;
  }
}
