/**
 * === W37 telegram (Coder C) ===
 * J244 — The 24h session window is a WhatsApp concept: cart-recovery nudges
 * (and other cron nudges) must NOT be suppressed on telegram, while WA keeps
 * its window semantics byte-for-byte.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J244",
  name: "cart nudge: no 24h window on telegram, WA window preserved",
  feature: "W37 caller parity: requiresSessionWindow / cart_abandonment",
  async run(_world: World) {
    const parity = await import("../../server/services/channelParity");
    const { channelCapabilities } = await import("../../server/services/channelSender");

    // 1. Window doctrine.
    assert(parity.requiresSessionWindow("whatsapp") === true, "WA requires the 24h window");
    assert(parity.requiresSessionWindow("telegram") === false, "telegram has NO 24h window");
    assert(parity.canSendFreeform("whatsapp", false) === false, "WA free-form suppressed outside the window");
    assert(parity.canSendFreeform("whatsapp", true) === true, "WA free-form allowed inside the window");
    assert(parity.canSendFreeform("telegram", false) === true, "telegram nudge NEVER window-suppressed");
    assert(parity.canSendFreeform("telegram", true) === true, "telegram free-form allowed regardless");
    assert(channelCapabilities("telegram").requiresSessionWindow === false, "capability matrix agrees (telegram)");
    assert(channelCapabilities("whatsapp").requiresSessionWindow === true, "capability matrix agrees (WA)");

    // 2. Cart-recovery route: a telegram cart session key (`telegram:<id>`)
    //    is delivered even when the (irrelevant) WA window would be closed.
    const seen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p) => {
      seen.push({ channel, to, ...(p as any) });
      return { sent: true, simulated: false };
    });
    try {
      const windowOpen = false; // outside the WA 24h window
      const cartSessionKey = "telegram:424242";
      if (parity.canSendFreeform("telegram", windowOpen)) {
        const r = await parity.notifyCustomer("t1", cartSessionKey, "cart_abandonment", {
          text: "You left items in your cart — complete your order anytime.",
          notifType: "cart_recovery",
        });
        assert(r.handled && r.sent === true, "telegram cart nudge must be sent despite the closed WA window");
      } else {
        throw new Error("telegram nudge wrongly suppressed by window logic");
      }
      assert(seen.length === 1 && seen[0].to === "424242", "nudge delivered to the telegram chat");

      // Same situation on WA: suppressed → template path (caller-owned).
      assert(parity.canSendFreeform("whatsapp", windowOpen) === false, "WA nudge outside window must use template fallback");
    } finally {
      parity.__setChannelSenderForTests(null);
    }
  },
};
