/**
 * === W37 telegram (Coder C) ===
 * J245 — Escalation/handoff notice parity: an agent reply on a
 * telegram-channel conversation routes to the customer's telegram chat via
 * channelSender; a WA conversation is handed back to the unchanged waSender
 * path. Resolution is fail-open (lookup failure → WA).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J245",
  name: "escalation parity: telegram conversations reply via channelSender",
  feature: "W37 caller parity: escalation category",
  async run(_world: World) {
    const parity = await import("../../server/services/channelParity");

    const seen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p, opts) => {
      seen.push({ channel, to, ...(p as any), ...(opts as any) });
      return { sent: true, simulated: false };
    });
    try {
      // Telegram conversation: explicit channel + chat id.
      const rTg = await parity.notifyCustomer(
        "t1",
        { channel: "telegram", channelScopedId: "555777" },
        "escalation",
        { text: "Agent: thanks for your patience — refund processed.", notifType: "conversation_reply" },
      );
      assert(rTg.handled && rTg.channel === "telegram", "telegram conversation handled by channelSender");
      assert(seen[0].to === "555777", "reply goes to the conversation chat_id");
      assert(seen[0].notifType === "conversation_reply", "notifType preserved for analytics");

      // WA conversation: falls through to the unchanged waSender path.
      const rWa = await parity.notifyCustomer(
        "t1",
        { channel: "whatsapp", phone: "2348055550000" },
        "escalation",
        { text: "Agent: hello" },
      );
      assert(rWa.handled === false && rWa.channel === "whatsapp", "WA conversation must use the original path");
      assert(seen.length === 1, "no channelSender call for WA");

      // Fail-open: a telegram ref WITHOUT a chat id degrades to WA reporting
      // instead of throwing (caller shows its NOT_FOUND branch).
      const rBroken = await parity.notifyCustomer("t1", { channel: "telegram", channelScopedId: "" }, "escalation", { text: "x" });
      assert(rBroken.handled === false, "telegram ref without chat id fails open to the WA branch");

      // category registry sanity for this journey's category.
      assert(parity.getParityCategory("escalation")?.telegram === "full", "escalation registered as full telegram parity");
    } finally {
      parity.__setChannelSenderForTests(null);
    }
  },
};
