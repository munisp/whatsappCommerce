/**
 * === W37 telegram (Coder C) ===
 * J241 — Delivery PIN via telegram: the logistics delivery_pin category
 * routes the identical PIN text to the buyer's telegram chat, and the PIN
 * survives channel adaptation untouched (keyboard flows reuse the existing
 * id grammar via toTelegramInlineKeyboard).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J241",
  name: "delivery PIN parity: telegram chat receives the identical PIN text",
  feature: "W37 caller parity: delivery_pin category (logistics seam)",
  async run(_world: World) {
    const parity = await import("../../server/services/channelParity");

    const pinText =
      "📦 Your order is being prepared for delivery with Speedy.\n" +
      "Tracking ID: TRK-1\n" +
      "🔑 Your delivery PIN is *482913* — share it with the rider ONLY when you receive your order.\n" +
      "🔎 Track your order: https://track.example/ORD-1";

    const seen: any[] = [];
    parity.__setChannelSenderForTests(async (tenantId, channel, to, p, opts) => {
      seen.push({ tenantId, channel, to, ...(p as any), ...(opts as any) });
      return { sent: true, simulated: false };
    });
    try {
      // 1. Session-key form (`telegram:<chat_id>`) resolves to telegram.
      const r = await parity.notifyCustomer("t1", "telegram:775533", "delivery_pin", {
        text: pinText,
        notifType: "shipment_created",
        orderId: "ORD-1",
      });
      assert(r.handled && r.channel === "telegram", "telegram:<id> ref must route to telegram");
      assert(seen[0].to === "775533", "chat_id must be extracted from the session key");
      assert(seen[0].text.includes("*482913*"), "PIN text must survive routing verbatim");
      assert(seen[0].text.includes("share it with the rider ONLY"), "PIN warning line must survive verbatim");
      assert(seen[0].orderId === "ORD-1", "orderId propagated for logging");

      // 2. Keyboard-flow equivalence: existing WA button id grammar maps to
      //    telegram inline keyboards 1:1 (callback_data carries the SAME id).
      const kb = parity.toTelegramInlineKeyboard([
        { id: "order_confirm:ORD-1", label: "Confirm delivery" },
        { id: "menu_2", label: "My orders" },
      ]);
      assert(kb.length === 2, "one row per button");
      assert(kb[0][0].callback_data === "order_confirm:ORD-1", "order_* id grammar preserved in callback_data");
      assert(kb[1][0].callback_data === "menu_2", "menu_<n> id grammar preserved in callback_data");
      assert(!("url" in kb[0][0]), "callback buttons must not carry a url");

      // 3. WA buyer: the caller's unchanged sendWhatsAppText path is used.
      const rWa = await parity.notifyCustomer("t1", { channel: "whatsapp", phone: "2348099999999" }, "delivery_pin", { text: pinText });
      assert(rWa.handled === false, "WA buyer falls through to the unchanged WA PIN send");
    } finally {
      parity.__setChannelSenderForTests(null);
    }
  },
};
