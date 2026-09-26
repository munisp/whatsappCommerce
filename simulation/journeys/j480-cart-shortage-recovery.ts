/**
 * J480 — a stock shortage is actually recoverable, on both the "remove it" and "I'll take fewer" paths.
 *
 * Found live 2026-09-25: a buyer told (by the bot's own words) "Adjust your quantities or remove the unavailable
 * items, then confirm again" had NO way to do either. Tracing it surfaced that `remove_from_cart` has been a
 * declared, LLM-recognized intent (see nlp.ts's system prompt) since this router was written, but never had a
 * server-side handler at all — not a Telegram-only or fallback-only gap, a gap in the shared checkout code every
 * channel and the real LLM both go through. And re-mentioning a shortage-flagged item to correct the quantity
 * ("I'll take 3") used to just ADD 3 more on top of the stuck original quantity, reproducing the exact same
 * shortage — never actually recoverable.
 *
 * Sequence note: "confirm" alone only shows the cart + asks pickup/delivery (`buildFulfillmentPrompt` — also
 * headed "🛒 *Your order*", easy to mistake for a completed order at a glance); the actual stock check, and so the
 * shortage, only happens once a fulfillment choice is answered (`createChatOrder`, in the pre-LLM deterministic
 * checkout-step block — unaffected by the LLM outage below, since fulfillment answers never reach the LLM at all).
 *
 * Runs with the LLM forced down throughout (this is exactly how it was found — see J478's comment on why that's a
 * faithful reproduction, not a shortcut) so the two fixed paths are proven through `classifyDeterministically` too.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, PRODUCTS, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J480",
  name: "cart shortage recovery: remove the short item, or re-state a lower quantity to replace it",
  feature: "remove_from_cart intent + shortage-aware add (replace, not stack, the flagged item)",
  async run(world: World) {
    const { llm } = await import("../metaMock");
    const schema = await import("../../drizzle/schema");

    llm.forceNetworkError = true;
    try {
      // ── A. Remove the short item, keep the rest, confirm succeeds with only what's left. ──────────────────────
      const phoneA = world.newPhone("j480a");
      await world.grantConsent(phoneA);

      let before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "shop");
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 15000, "shop handoff");

      before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "2 grilled chicken and 60 jollof rice"); // jollof stock is 50 — deliberately over
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 20000, "add-to-cart reply");
      const addReply = bodyText(world.outbound.lastOfType("text", phoneA));
      assertIncludes(addReply, "Grilled Chicken", "chicken added");
      assertIncludes(addReply, "Jollof Rice", "jollof rice added (even though the quantity is more than in stock — that's only checked once fulfillment is chosen)");

      before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "confirm");
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 20000, "fulfillment prompt");
      assertIncludes(bodyText(world.outbound.lastOfType("text", phoneA)), "Pickup", "confirm shows the cart + asks pickup/delivery (stock isn't checked yet)");

      before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "1"); // pickup — THIS is what actually checks stock
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 15000, "shortage reply");
      const shortageReply = bodyText(world.outbound.lastOfType("text", phoneA));
      assertIncludes(shortageReply, "out of stock", "shortage reported");
      assertIncludes(shortageReply, "Grilled Chicken", "the still-available item is shown");
      assertIncludes(shortageReply, "remove the unavailable items", "the bot's own recovery instructions are shown");

      before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "remove jollof rice");
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 20000, "removal confirmation");
      const removeReply = bodyText(world.outbound.lastOfType("text", phoneA));
      assertIncludes(removeReply, "Removed", "removal acknowledged");
      assertIncludes(removeReply, "Jollof Rice", "the removed item is named");
      assert(!/jollof rice/i.test(removeReply.split("Your cart now")[1] ?? ""), "jollof rice is actually gone from the cart listing shown, not just acknowledged in words");

      before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "confirm");
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 20000, "fulfillment prompt (2)");
      assertIncludes(bodyText(world.outbound.lastOfType("text", phoneA)), "Pickup", "confirm again asks pickup/delivery");

      before = world.outbound.ofType("text", phoneA).length;
      await world.text(phoneA, "1");
      await world.waitFor(() => world.outbound.ofType("text", phoneA).length > before, 15000, "order summary after removal");
      const finalReplyA = bodyText(world.outbound.lastOfType("text", phoneA));
      assert(!/out of stock|didn.t quite get that/i.test(finalReplyA), `confirming after removal must actually succeed, not repeat the shortage or miss (got: ${finalReplyA.slice(0, 200)})`);

      const [orderA] = await world.db.select().from(schema.orders).where(eq(schema.orders.customerId, phoneA));
      assert(!!orderA, "an order was created after removing the short item");
      assert(Number(orderA.totalAmount) === Number(PRODUCTS.chicken.price) * 2, `order total must be exactly 2 chicken (no jollof rice) — got ${orderA.totalAmount}`);

      // ── B. Re-state a LOWER quantity for the shortage-flagged item — must REPLACE, not add on top (the exact
      //      live bug: "I'll take 3" after a shortage used to become original+3, reproducing the same shortage). ──
      const phoneB = world.newPhone("j480b");
      await world.grantConsent(phoneB);

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "shop");
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 15000, "shop handoff (B)");

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "60 jollof rice"); // over the 50-unit stock — guaranteed shortage
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 20000, "add-to-cart reply (B)");

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "confirm");
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 20000, "fulfillment prompt (B)");
      assertIncludes(bodyText(world.outbound.lastOfType("text", phoneB)), "Pickup", "confirm (B) asks pickup/delivery");

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "1");
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 15000, "shortage reply (B)");
      assertIncludes(bodyText(world.outbound.lastOfType("text", phoneB)), "out of stock", "shortage reported (B)");

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "Alright I'll take 30 jollof rice"); // within stock; must REPLACE the stuck 60
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 20000, "replace reply (B)");

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "confirm");
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 20000, "fulfillment prompt (B2)");
      assertIncludes(bodyText(world.outbound.lastOfType("text", phoneB)), "Pickup", "confirm (B2) asks pickup/delivery");

      before = world.outbound.ofType("text", phoneB).length;
      await world.text(phoneB, "1");
      await world.waitFor(() => world.outbound.ofType("text", phoneB).length > before, 15000, "order summary after replace (B)");
      const finalReplyB = bodyText(world.outbound.lastOfType("text", phoneB));
      assert(!/out of stock|didn.t quite get that/i.test(finalReplyB), `re-stating a lower quantity must resolve the shortage, not repeat it (got: ${finalReplyB.slice(0, 200)})`);

      const [orderB] = await world.db.select().from(schema.orders).where(eq(schema.orders.customerId, phoneB));
      assert(!!orderB, "an order was created after replacing the quantity");
      // This is the real proof of the "replace, don't stack" fix: 60 (stuck) + 30 (re-stated) would total 90 ×
      // 2500 = ₦225,000 if the old additive bug were still there; a correct replace gives exactly 30 × 2500.
      assert(
        Number(orderB.totalAmount) === Number(PRODUCTS.jollof.price) * 30,
        `order must be exactly 30 jollof rice (replaced, not 60+30=90 stacked on top) — got ${orderB.totalAmount}, expected ${Number(PRODUCTS.jollof.price) * 30}`,
      );
    } finally {
      llm.forceNetworkError = false;
    }
  },
};
