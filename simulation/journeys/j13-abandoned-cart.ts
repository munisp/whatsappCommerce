/**
 * J13 — Abandoned cart: an idle cart gets ONE recovery message per 24h via
 * the cron sweep, consented buyers only; replying resumes the conversation.
 */
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { nlpAddToCart } from "./helpers";

export const journey: Journey = {
  id: "J13",
  name: "abandoned cart recovery",
  feature: "cartRecovery cron (1×/24h, consent-gated)",
  async run(world) {
    // Consented buyer with an idle cart.
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    await nlpAddToCart(world, phone, "add 1 jollof to my cart", [{ product: "Jollof Rice", quantity: 1 }]);

    // Non-consented buyer with an idle cart.
    const phoneNC = world.newPhone("b");
    await nlpAddToCart(world, phoneNC, "add 1 chicken to my cart", [{ product: "Grilled Chicken", quantity: 1 }]);

    // Make both carts idle (>60min stale).
    await world.backdate(
      `UPDATE cart_sessions SET "updatedAt" = NOW() - INTERVAL '2 hours' WHERE "tenantId" = $1`,
      [TENANT_ID],
    );

    const baseCount = world.outbound.toPhone(phone).length;
    const baseNC = world.outbound.toPhone(phoneNC).length;

    // 1st sweep: consented buyer nudged, non-consented skipped.
    const run1 = await world.runCron("/api/scheduled/cart-recovery", { idleMinutes: 60 });
    assert(run1.status === 200, `cart-recovery cron accepted (got ${run1.status})`);
    await world.waitFor(() => world.outbound.toPhone(phone).length > baseCount, 8000, "recovery message sent");
    const recovery = world.outbound.toPhone(phone).slice(baseCount).map((c) => bodyText(c)).join("\n");
    assertIncludes(recovery, "left items in your cart", "localized recovery copy sent");
    assert(world.outbound.toPhone(phoneNC).length === baseNC, "non-consented buyer got NO recovery message");

    // 2nd sweep: marker dedupes — nothing re-sent.
    const count2 = world.outbound.toPhone(phone).length;
    await world.runCron("/api/scheduled/cart-recovery", { idleMinutes: 60 });
    await world.settle(500);
    assert(world.outbound.toPhone(phone).length === count2, "second sweep does not re-nudge within 24h");

    // Reply resumes the conversation (cart still alive).
    world.llm.when("yes i want to finish my order", {
      reply: "Great! Your cart has 1 × Jollof Rice. Say 'confirm' to check out.",
      intent: "view_cart",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "yes i want to finish my order");
    const resumed = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(resumed, "Jollof Rice", "reply after recovery resumes the cart conversation");
  },
};
