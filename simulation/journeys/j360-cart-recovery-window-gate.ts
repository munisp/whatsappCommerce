// === W45 messaging-services (Coder A2) ===
/**
 * J360 — Cart recovery 24h-window gate + template fallback (MSG-11):
 * a WhatsApp cart whose buyer's last inbound is INSIDE the window gets the
 * free-form localized nudge; one whose window is CLOSED gets the approved
 * template (wac_cart_recovery) instead — never free-form text outside the
 * window.
 */
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart } from "./helpers";

export const journey: Journey = {
  id: "J360",
  name: "cart recovery window gate + template fallback",
  feature: "MSG-11 getWindow gate, template outside the 24h window",
  async run(world: World) {
    const { recordInbound } = await import("../../server/services/sessionWindow");

    // ── Window OPEN → free-form localized text (unchanged behaviour) ────
    const phoneOpen = world.newPhone("j360a");
    await world.grantConsent(phoneOpen);
    await nlpAddToCart(world, phoneOpen, "add 1 jollof to my cart [j360a]", [{ product: "Jollof Rice", quantity: 1 }]);

    // ── Window CLOSED → template fallback ───────────────────────────────
    const phoneClosed = world.newPhone("j360b");
    await world.grantConsent(phoneClosed);
    await nlpAddToCart(world, phoneClosed, "add 1 chicken to my cart [j360b]", [{ product: "Grilled Chicken", quantity: 1 }]);
    // Push the last-inbound marker 48h into the past: window closed.
    await recordInbound(TENANT_ID, phoneClosed, new Date(Date.now() - 48 * 3600_000));
    await world.backdate(
      `UPDATE whatsapp_customer_replies SET created_at = NOW() - INTERVAL '48 hours' WHERE tenant_id = $1 AND from_phone = $2`,
      [TENANT_ID, phoneClosed],
    );

    // Make every cart idle (>60min stale).
    await world.backdate(
      `UPDATE cart_sessions SET "updatedAt" = NOW() - INTERVAL '2 hours' WHERE "tenantId" = $1`,
      [TENANT_ID],
    );

    const openBase = world.outbound.toPhone(phoneOpen).length;
    const closedBase = world.outbound.toPhone(phoneClosed).length;
    const run = await world.runCron("/api/scheduled/cart-recovery", { idleMinutes: 60 });
    assert(run.status === 200, `cart-recovery cron accepted (got ${run.status})`);

    await world.waitFor(() => world.outbound.toPhone(phoneOpen).length > openBase, 8000, "in-window nudge sent");
    const openMsg = world.outbound.lastOfType("text", phoneOpen);
    assertIncludes(bodyText(openMsg), "left items in your cart", "in-window buyer got the free-form nudge");

    await world.waitFor(() => world.outbound.toPhone(phoneClosed).length > closedBase, 8000, "closed-window fallback sent");
    const closedTpl = world.outbound.lastOfType("template", phoneClosed);
    assert(closedTpl, "closed-window buyer got a TEMPLATE (not free-form text)");
    assert(closedTpl.body?.template?.name === "wac_cart_recovery", `approved cart-recovery template used (got ${closedTpl.body?.template?.name})`);
    // No NEW free-form text to the closed-window buyer after the baseline.
    const closedNewTexts = world.outbound.toPhone(phoneClosed).slice(closedBase).filter((c) => c.waType === "text");
    assert(closedNewTexts.length === 0, "no free-form text outside the 24h window");
  },
};
