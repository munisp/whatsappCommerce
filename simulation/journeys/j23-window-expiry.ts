/**
 * J23 — Window expiry: an unpaid order older than 20h with the 24h messaging
 * window closing gets ONE payment nudge (deduped); a buyer whose window has
 * fully closed gets the approved template instead. Admin is flagged.
 */
import { ADMIN_PHONE, TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J23",
  name: "window expiry nudge",
  feature: "sessionWindow expiry cron (dedupe)",
  async run(world) {
    const { recordInbound } = await import("../../server/services/sessionWindow");

    // ── Case 1: window closing (last inbound 23.5h ago) ──────────────────
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });
    await world.backdate(`UPDATE orders SET "createdAt" = NOW() - INTERVAL '21 hours' WHERE id = $1`, [order.orderId]);
    await recordInbound(TENANT_ID, phone, new Date(Date.now() - 23.5 * 3600_000));

    const base = world.outbound.toPhone(phone).length;
    const run1 = await world.runCron("/api/scheduled/window-expiry-check");
    assert(run1.status === 200 && run1.json?.ok, `expiry cron ok (got ${run1.status})`);
    assert(run1.json.nudged >= 1, `buyer nudged (nudged=${run1.json.nudged})`);
    const nudge = world.outbound.toPhone(phone).slice(base).map((c) => bodyText(c)).join("\n");
    assertIncludes(nudge, "still awaiting payment", "nudge copy delivered to the buyer");
    assertIncludes(nudge, order.orderNumber, "nudge references the order number");

    // Admin flag.
    const adminMsgs = world.outbound.toPhone(ADMIN_PHONE).map((c) => bodyText(c)).join("\n");
    assertIncludes(adminMsgs, order.orderNumber, "admin flag references the order");
    assertIncludes(adminMsgs, "unpaid >20h", "admin flag explains the situation");
    assert(run1.json.flagged >= 1, "admin flag counted");

    // Dedupe: second run must not resend.
    const count2 = world.outbound.toPhone(phone).length;
    const run2 = await world.runCron("/api/scheduled/window-expiry-check");
    await world.settle(400);
    assert(world.outbound.toPhone(phone).length === count2, "no duplicate nudge on the second run");
    assert(
      (run2.json.nudged ?? 0) === 0,
      `second run nudged 0 for already-nudged orders (got ${run2.json.nudged})`,
    );

    // ── Case 2: window fully closed (25h) → template nudge ───────────────
    const phoneB = world.newPhone("b");
    await world.grantConsent(phoneB);
    const orderB = await createChatOrderViaNlp(world, phoneB, { items: [{ product: "Grilled Chicken", quantity: 1 }] });
    await world.backdate(`UPDATE orders SET "createdAt" = NOW() - INTERVAL '21 hours' WHERE id = $1`, [orderB.orderId]);
    await recordInbound(TENANT_ID, phoneB, new Date(Date.now() - 25 * 3600_000));

    const baseB = world.outbound.toPhone(phoneB).length;
    const run3 = await world.runCron("/api/scheduled/window-expiry-check");
    assert(run3.status === 200, "third cron run ok");
    const tpl = world.outbound.toPhone(phoneB).slice(baseB).find((c) => c.waType === "template");
    assert(tpl, "closed-window buyer gets the approved template nudge");
    assert(tpl!.body?.template?.name === "sim_broadcast", "tenant broadcast template used for the out-of-window nudge");
  },
};
