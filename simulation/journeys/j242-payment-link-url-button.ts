/**
 * === W37 telegram (Coder C) ===
 * J242 — Payment-link parity: on telegram the link is delivered as a URL
 * inline-button to the PSP checkout — NEVER a wa.me deep link. On WhatsApp
 * the payload (including the legacy wa.me callback) is byte-identical.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J242",
  name: "payment link: telegram URL button, never wa.me; WA unchanged",
  feature: "W37 caller parity: payment_link category adapter",
  async run(_world: World) {
    const { adaptForChannel, toTelegramInlineKeyboard } = await import("../../server/services/channelParity");

    const payload = {
      text: "Your order total is ₦12,500. Pay securely: https://wa.me/2348012345678 (after payment you'll return here)",
      paymentUrl: "https://checkout.paystack.com/abc123",
      waMeUrl: "https://wa.me/2348012345678",
      notifType: "payment_link",
    };

    // Telegram: wa.me stripped from the text, PSP URL attached as a button.
    const tg = adaptForChannel("payment_link", "telegram", payload);
    assert(!tg.text.includes("wa.me"), `telegram text must not contain wa.me links: ${tg.text}`);
    assert(tg.buttons && tg.buttons.length === 1, "telegram must get exactly one pay button");
    assert(tg.buttons![0].url === "https://checkout.paystack.com/abc123", "button URL must be the PSP checkout URL");
    const kb = toTelegramInlineKeyboard(tg.buttons!);
    assert(kb[0][0].url === "https://checkout.paystack.com/abc123", "inline keyboard carries the URL");
    assert(!("callback_data" in kb[0][0]), "URL buttons must not carry callback_data");

    // WhatsApp: byte-identical passthrough (same object fields, wa.me kept).
    const wa = adaptForChannel("payment_link", "whatsapp", payload);
    assert(wa === payload, "WA payload must be returned untouched (byte-equivalent)");
    assert(wa.text.includes("https://wa.me/2348012345678"), "WA keeps the wa.me callback link");

    // Other categories are passthrough text on telegram (no url mangling).
    const other = adaptForChannel("dunning", "telegram", { text: "Pay up: https://pay.example/x" });
    assert(other.text === "Pay up: https://pay.example/x", "non-payment-link text untouched on telegram");
  },
};
