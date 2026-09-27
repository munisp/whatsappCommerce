// === W49 RICHMEDIA ===
/**
 * J490 — RICH-7: payment links go out as a WA cta_url interactive button
 * (not a raw pasted URL); TG keeps its URL inline button. Both channels now
 * show a real "Pay now" button.
 *
 * Also asserts the builder rejects non-https URLs (Meta requires https).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J490",
  name: "cta_url pay button on WA + URL button on TG",
  feature: "RICH-7",
  async run(world: World) {
    const { sendWhatsAppPaymentCta, sendTelegramPaymentCta } = await import("../../server/services/richMedia");
    const { buildInteractivePayload } = await import("../../server/services/waSender");
    const phone = "+2348017000490";
    const url = "https://pay.example.com/checkout/490";

    // Builder validation: cta_url requires absolute https.
    let threw = false;
    try {
      buildInteractivePayload({ bodyText: "pay", action: { type: "cta_url", displayText: "Pay", url: "http://insecure.example.com" } });
    } catch { threw = true; }
    assert(threw, "cta_url rejects non-https urls");

    // WA: cta_url interactive captured by the metaMock.
    await sendWhatsAppPaymentCta(TENANT_ID, phone, { url, orderNumber: "SO-490" });
    const wa = world.outbound.lastOfType("interactive", phone.replace("+", ""));
    assert(wa, "WA payment interactive captured");
    const ia = (wa!.body as any).interactive;
    assert(ia.type === "cta_url", `interactive type is cta_url (got ${ia.type})`);
    assert(ia.action?.name === "cta_url" && ia.action.parameters?.url === url, "cta_url parameters carry the pay link");
    assert(ia.action.parameters?.display_text === "Pay now", "button label");
    assert(String(ia.body.text).includes("SO-490"), "body references the order");

    // TG: URL inline button.
    await ensureTelegramConfig(world);
    tg.reset();
    await sendTelegramPaymentCta(TENANT_ID, "490001", { url, orderNumber: "SO-490" });
    const msg = tg.callsFor("sendMessage").pop();
    assert(msg?.body?.reply_markup?.inline_keyboard?.flat().some((b: any) => b.url === url), "TG pay URL button present");
  },
};
