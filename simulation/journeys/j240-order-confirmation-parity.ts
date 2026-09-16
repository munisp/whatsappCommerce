/**
 * === W37 telegram (Coder C) ===
 * J240 — Order confirmation renders on both channels with the SAME semantic
 * content: the WA template body params ({{1}} name, {{2}} order number,
 * {{3}} amount+currency, {{4}} status label) all appear in the telegram
 * text rendering, and the telegram route carries the template name for
 * analytics parity.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J240",
  name: "order confirmation parity: same semantic content on WA + telegram",
  feature: "W37 caller parity: order_status category adapter",
  async run(_world: World) {
    const { orderNotifTemplate } = await import("../../server/routers/whatsappNotifications");
    const parity = await import("../../server/services/channelParity");

    const payload = {
      tenantId: "t1",
      phone: "2348012345678",
      orderNumber: "ORD-4242",
      customerName: "Ada",
      totalAmount: "12500.00",
      currency: "NGN",
      status: "confirmation",
      notifType: "order_confirmation" as const,
    };

    // WA side: approved-template body params.
    const tpl = orderNotifTemplate(payload);
    const params = (tpl.components as any[])[0].parameters.map((x: any) => String(x.text));
    assert(params[0] === "Ada", `WA template {{1}} should be the customer name, got ${params[0]}`);
    assert(params[1] === "ORD-4242", `WA template {{2}} should be the order number`);
    assert(params[2] === "12500.00 NGN", `WA template {{3}} should be amount+currency`);
    assert(params[3] === "confirmed", `WA template {{4}} should be the status label`);

    // Telegram side: the SAME four semantic fields rendered as text.
    const tgText = parity.renderOrderStatusText({
      customerName: payload.customerName,
      orderNumber: payload.orderNumber,
      totalAmount: payload.totalAmount,
      currency: payload.currency,
      statusLabel: params[3],
    });
    for (const field of params) {
      assert(tgText.includes(field), `telegram render missing semantic field "${field}": ${tgText}`);
    }

    // Routing: explicit telegram ref delivers through channelSender with the
    // rendered text; WA ref is handed back (handled:false) for the unchanged
    // template path.
    const seen: any[] = [];
    // === W37 merger === real facade is a discriminated union + opts; the
    // override captures opts so notifType is still asserted end-to-end.
    parity.__setChannelSenderForTests(async (tenantId, channel, to, p, opts) => {
      seen.push({ tenantId, channel, to, ...(p as any), ...(opts as any) });
      return { sent: true, simulated: false };
    });
    try {
      const rTg = await parity.notifyCustomer("t1", { channel: "telegram", channelScopedId: "9911" }, "order_status", {
        text: tgText,
        notifType: payload.notifType,
      });
      assert(rTg.handled === true && rTg.channel === "telegram", "telegram route must be handled");
      assert(seen.length === 1 && seen[0].to === "9911", "channelSender must receive the chat_id");
      assert(seen[0].text === tgText, "telegram payload must carry the rendered order text");
      assert(seen[0].notifType === "order_confirmation", "template/notif name preserved for analytics parity");

      const rWa = await parity.notifyCustomer("t1", { channel: "whatsapp", phone: "2348012345678" }, "order_status", {
        text: tgText,
      });
      assert(rWa.handled === false && rWa.channel === "whatsapp", "WA route must fall through to the caller's template path");
      assert(seen.length === 1, "channelSender must NOT be invoked for a WA customer");
    } finally {
      parity.__setChannelSenderForTests(null);
    }
  },
};
