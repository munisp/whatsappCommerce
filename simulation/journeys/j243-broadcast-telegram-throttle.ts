/**
 * === W37 telegram (Coder C) ===
 * J243 — Broadcast mixed-channel fan-out: telegram recipients are throttled
 * at the Bot API ~30 msg/s fair-use limit; WA recipients keep the existing
 * window/template logic. Verified via the shared pacer + routing helpers
 * used by the broadcast.ts seam.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J243",
  name: "broadcast fan-out: telegram 30 msg/s throttle honored, WA untouched",
  feature: "W37 caller parity: broadcast category (throttle)",
  async run(_world: World) {
    const parity = await import("../../server/services/channelParity");

    // 1. The pacer enforces >= ceil(1000/30) = 34ms between telegram sends.
    assert(parity.TELEGRAM_BROADCAST_MIN_INTERVAL_MS >= 34, "interval must honor 30 msg/s");
    let now = 1_000_000;
    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    // Deterministic clock: virtual sleep advances `now` without real waiting.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      now += ms ?? 0;
      fn();
      return 0 as any;
    }) as any;
    try {
      const pacer = parity.createTelegramBroadcastPacer(() => now);
      const sentAt: number[] = [];
      for (let i = 0; i < 90; i++) {
        await pacer.waitForSlot();
        sentAt.push(now);
      }
      for (let i = 1; i < sentAt.length; i++) {
        assert(
          sentAt[i] - sentAt[i - 1] >= parity.TELEGRAM_BROADCAST_MIN_INTERVAL_MS,
          `send ${i} violated throttle: gap ${sentAt[i] - sentAt[i - 1]}ms`,
        );
      }
      // 90 sends at 30 msg/s must span at least ~89 intervals ≈ 3s of pacing.
      const spanMs = sentAt[sentAt.length - 1] - sentAt[0];
      assert(spanMs >= 89 * parity.TELEGRAM_BROADCAST_MIN_INTERVAL_MS, `90 sends must be paced over >= ${89 * 34}ms, got ${spanMs}ms`);
      assert(sleeps.every((ms) => ms <= parity.TELEGRAM_BROADCAST_MIN_INTERVAL_MS), "no over-sleeping");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // 2. Mixed audience routing: telegram phones route to channelSender
    //    (handled), WA phones fall through (handled:false) to the unchanged
    //    template/text path in broadcast.ts.
    const seen: any[] = [];
    parity.__setChannelSenderForTests(async (_t, channel, to, p, opts) => {
      seen.push({ channel, to, ...(p as any), ...(opts as any) });
      return { sent: true, simulated: false };
    });
    try {
      const audience = [
        { phone: "telegram:1001", body: "Promo A" },
        { phone: "telegram:1002", body: "Promo A" },
        { phone: "2348011111111", body: "Promo A" }, // WA — falls through
      ];
      let waFallthrough = 0;
      for (const m of audience) {
        const r = await parity.notifyCustomer("t1", m.phone, "broadcast", { text: m.body, notifType: "broadcast" });
        if (!r.handled) waFallthrough++;
      }
      assert(seen.length === 2, `expected 2 telegram sends, got ${seen.length}`);
      assert(seen[0].to === "1001" && seen[1].to === "1002", "both telegram chats fanned out");
      assert(seen.every((s) => s.notifType === "broadcast"), "notifType preserved");
      assert(waFallthrough === 1, "WA recipient must fall through to the unchanged WA broadcast path");
    } finally {
      parity.__setChannelSenderForTests(null);
    }
  },
};
