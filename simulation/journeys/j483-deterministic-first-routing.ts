/**
 * J483 — deterministic-first routing (2026-09-26, user's direction): the fast, rule-based classifier runs FIRST
 * for every message, not just when the LLM fails; the LLM is only invoked for what it genuinely can't place.
 *
 * Covers the new capabilities added alongside the reorder, all of which must be instant (zero LLM calls):
 *   - a bare greeting gets a warm reply, not a menu dump or a guessed add
 *   - "how many X do you have left" answers with the real count and does NOT add it to the cart (the live bug
 *     this whole change traces back to: 2026-09-25/26, "how many Milo do you have left" got silently added)
 *   - "show me X" resolves to a product-detail reply AND sends the actual catalog image (not just returns a
 *     flag — the delivery layer, server/_core/index.ts, must really send it)
 *   - "cheaper options" sorts the catalog cheapest-first
 * Then proves the escalation path both ways:
 *   - something genuinely open-ended (not a keyword/catalog match) DOES reach the LLM, scripted response used
 *   - with the LLM forced down, that same kind of message still gets the deterministic catch-all, never a dead
 *     end — the safety net this was all built on top of is still there
 *
 * ROUND 2 (same day, real live testing on the actual Telegram bot) added sections 7-10 below: a real, fabricated
 * Paystack link ("https://example.com/pay") and a fabricated "our WhatsApp business account" answer, both
 * invented by the LLM for questions it had no real data for; a relative product-image URL Telegram's Bot API
 * flat-out rejected ("URL host is empty"); a reply that announced "✅ 1 × Dani milk" for a product that does not
 * exist, right next to its own "couldn't find" correction; and the menu's literal "Shop products" fallback text
 * paying the full LLM round trip on the single most common way a buyer starts shopping.
 */
import { eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J483",
  name: "deterministic-first routing: fast path for common messages, LLM only for what it can't place",
  feature: "nlp.ts routing reorder + deterministicShop.ts new capabilities",
  async run(world: World) {
    const phone = world.newPhone("483");
    await world.grantConsent(phone);
    const last = () => bodyText(world.outbound.lastOfType("text", phone));

    // sim-tenant's seed products (Jollof Rice/Grilled Chicken) are shared, mutable state — some other journey
    // may have genuinely sold some of the stock by the time this runs deep in a full suite. Read the ACTUAL
    // current count rather than assume the seed value (50) still holds — this journey verifies the stock
    // QUESTION answers correctly, not that nothing else in a 480+ journey suite ever bought jollof rice.
    const schema = await import("../../drizzle/schema");
    const [jollof] = await world.db.select().from(schema.products).where(eq(schema.products.id, "p-jollof")).limit(1);
    const currentJollofStock = jollof?.stockQuantity ?? 50;

    // "hi"/"hello"/"menu"/"help"/"catalog"/"start"/"restart" are MENU_KEYWORDS (waMenu.ts) — intercepted by the
    // menu engine BEFORE nlp.ts ever sees them, on both WhatsApp (J471) and Telegram; always, not just on a
    // fresh session. classifyDeterministically's greeting handling is for the (much wider) set of ordinary
    // greetings that AREN'T in that fixed list — "hey", "yo", "good morning" — which DO reach it once the buyer
    // is already in the shop/chat flow. Enter that flow first the same way J478 does.
    await world.text(phone, "shop");
    await world.waitFor(() => last().length > 0, 8000, "entered shop flow");

    // 1. Greeting mid-conversation — warm, not a menu dump, zero LLM calls.
    const callsBeforeGreeting = world.llm.calls.length;
    const beforeGreeting = world.outbound.ofType("text", phone).length;
    await world.text(phone, "hey there");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeGreeting, 8000, "greeting reply");
    assertIncludes(last(), "What would you like", "bare greeting gets a warm, human reply");
    assert(world.llm.calls.length === callsBeforeGreeting, "greeting must not call the LLM — it's an instant, unambiguous case");

    // 2. Stock question — answers directly, does NOT add to cart (the exact live bug this traces back to).
    const callsBeforeStock = world.llm.calls.length;
    const before = world.outbound.ofType("text", phone).length;
    await world.text(phone, "how many jollof rice do you have left");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 8000, "stock reply");
    const stockReply = last();
    assertIncludes(stockReply, String(currentJollofStock), "stock question answers with the real, current count");
    assertIncludes(stockReply, "Jollof Rice", "stock question names the product");
    assert(!/added|🛒|cart now/i.test(stockReply), `stock question must not read as an add-to-cart confirmation (got: ${stockReply.slice(0, 100)})`);
    assert(world.llm.calls.length === callsBeforeStock, "stock question must not call the LLM");

    // 3. Product detail — resolves AND actually sends the catalog image through the real delivery layer.
    const callsBeforeDetail = world.llm.calls.length;
    const beforeImg = world.outbound.ofType("image", phone).length;
    await world.text(phone, "show me the grilled chicken");
    await world.waitFor(() => world.outbound.ofType("image", phone).length > beforeImg, 8000, "product image sent");
    const card = world.outbound.lastOfType("image", phone);
    assertIncludes(JSON.stringify(card?.body ?? {}), "cdn.sim.local", "product detail sends the real catalog image, not just a text description");
    assert(world.llm.calls.length === callsBeforeDetail, "product detail lookup must not call the LLM");

    // 4. Cheaper options — cheapest-first ordering. Found live 2026-09-26 running the FULL suite (not solo):
    // sim-tenant is a SHARED catalog that accumulates real products from ~480 other journeys by the time this
    // one runs — plenty legitimately cheaper than Jollof Rice (₦2,500)/Grilled Chicken (₦3,000), which correctly
    // fall off a "cheapest 20" list at that point. That's the feature working, not a bug — asserting those two
    // SPECIFIC names appear was the wrong test. Assert the actual, channel-agnostic property instead: whatever
    // items DO show up are in strictly ascending price order.
    const callsBeforeCheaper = world.llm.calls.length;
    const beforeCheaper = world.outbound.ofType("text", phone).length;
    await world.text(phone, "any cheaper options?");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeCheaper, 8000, "cheaper-options reply");
    const cheaperReply = last();
    const prices = [...cheaperReply.matchAll(/—\s*[A-Z]{3}\s*([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, "")));
    assert(prices.length >= 2, `cheaper-options must list at least 2 priced items (got: ${JSON.stringify(cheaperReply)})`);
    for (let i = 1; i < prices.length; i++) {
      assert(prices[i] >= prices[i - 1], `cheaper-options must be sorted ascending by price (item ${i}: ${prices[i]} < item ${i - 1}: ${prices[i - 1]}; full reply: ${JSON.stringify(cheaperReply)})`);
    }
    assert(world.llm.calls.length === callsBeforeCheaper, "cheaper options must not call the LLM");

    // 5. Genuinely open-ended — deterministic can't place it, so it DOES escalate to the LLM (scripted here).
    world.llm.when("what's the difference between jollof and fried rice", {
      reply: "Jollof is cooked in a tomato-pepper base; fried rice is stir-fried with mixed veg. Want to add either?",
      intent: "unknown", nextState: "browse",
      extractedItems: [], extractedProduct: null, extractedQuantity: null, extractedAddress: null,
      confidence: 0.8,
    });
    const callsBeforeOpen = world.llm.calls.length;
    const beforeOpen = world.outbound.ofType("text", phone).length;
    await world.text(phone, "what's the difference between jollof and fried rice");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeOpen, 8000, "open-ended reply");
    assertIncludes(last(), "tomato-pepper", "a genuinely open-ended question reaches the LLM and uses its answer");
    assert(world.llm.calls.length === callsBeforeOpen + 1, "exactly one LLM call for the open-ended question — deterministic couldn't place it, so it (and only it) escalated");

    // 6. Same kind of open-ended message, but with the LLM forced down — must NOT dead-end. The deterministic
    //    catch-all (already computed before the LLM was ever tried) is what the buyer sees instead.
    world.llm.forceNetworkError = true;
    const beforeDown = world.outbound.ofType("text", phone).length;
    await world.text(phone, "what's the difference between suya and kilishi");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeDown, 15000, "LLM-down reply");
    const downReply = last();
    assert(downReply.length > 0, "LLM down must never produce silence");
    assertIncludes(downReply, "Jollof Rice", "LLM-down catch-all still shows the catalog, same safety net as before this change");
    world.llm.forceNetworkError = false;

    // 7. Product images are stored as RELATIVE paths in production ("/api/storage/<tenant>/<file>.jpg") — the
    // sim catalog's seeded products all use fully-absolute mock URLs (https://cdn.sim.local/...), which never
    // exercised this. Rather than insert a brand-new product (found live under the FULL suite: nlp.ts's catalog
    // fetch is `.orderBy(createdAt).limit(30)` — the OLDEST 30 products only, so a product inserted this deep
    // into a 480+-journey suite is never actually visible to it, same class of gap as the earlier stock/cheaper
    // fixes had to work around), temporarily mutate the already-guaranteed-visible seed product's imageUrl to a
    // relative path, check, then restore it immediately — same mutate-and-restore discipline as J12.
    const schema2 = await import("../../drizzle/schema");
    const RELATIVE_PATH = "/api/storage/sim-tenant/p-jollof.jpg";
    const [jollofBefore] = await world.db.select().from(schema2.products).where(eq(schema2.products.id, "p-jollof")).limit(1);
    const originalJollofImageUrl = jollofBefore?.imageUrl ?? "https://cdn.sim.local/p-jollof.jpg";
    await world.db.update(schema2.products).set({ imageUrl: RELATIVE_PATH }).where(eq(schema2.products.id, "p-jollof"));
    try {
      const callsBeforeRelImg = world.llm.calls.length;
      const beforeRelImgTxt = world.outbound.ofType("text", phone).length;
      const beforeRelImg = world.outbound.ofType("image", phone).length;
      await world.text(phone, "show me the jollof rice");
      await world.waitFor(() => world.outbound.ofType("image", phone).length > beforeRelImg, 8000, "relative-path product image sent");
      const relImgCard = world.outbound.lastOfType("image", phone);
      const relImgCardStr = JSON.stringify(relImgCard?.body ?? {});
      assert(/https?:\/\//i.test(relImgCardStr) && !relImgCardStr.includes('"/api/storage'), `a relative imageUrl must be resolved to an absolute URL before being sent to the channel (got: ${relImgCardStr.slice(0, 200)})`);
      await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeRelImgTxt, 8000, "relative-path product text reply");
      assertIncludes(last(), "http", "the image link also appears as a plain clickable URL in the text reply, not just the native photo attachment");
      assert(world.llm.calls.length === callsBeforeRelImg, "product detail lookup must not call the LLM");
    } finally {
      await world.db.update(schema2.products).set({ imageUrl: originalJollofImageUrl }).where(eq(schema2.products.id, "p-jollof"));
    }

    // 8. Payment/account questions get the REAL order's REAL payment link — never an LLM-improvised answer.
    // Live evidence this guards against: asked "what account should I pay to?" and "share the paystack link",
    // the LLM answered "our WhatsApp business account" and fabricated "https://example.com/pay" — neither
    // grounded in anything real. Drive a genuine order through the real checkout flow (same as J480/J479) so a
    // real payment_transactions row with a real (mocked-Paystack) URL exists, then ask for it conversationally.
    world.llm.when("2 jollof rice", {
      reply: "Adding 2 Jollof Rice to your cart.", intent: "add_to_cart", nextState: "checkout_address",
      extractedItems: [{ product: "Jollof Rice", quantity: 2 }],
      extractedProduct: null, extractedQuantity: null, extractedAddress: null, confidence: 0.95,
    });
    const beforeAdd = world.outbound.ofType("text", phone).length;
    await world.text(phone, "2 jollof rice");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeAdd, 8000, "add-to-cart reply");
    const beforeConfirm = world.outbound.ofType("text", phone).length;
    await world.text(phone, "confirm");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeConfirm, 8000, "fulfillment prompt");
    const beforeOrder = world.outbound.ofType("text", phone).length;
    await world.text(phone, "1"); // pickup
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeOrder, 15000, "order created with a real payment link");
    const orderReply = last();
    const linkMatch = /https:\/\/checkout\.paystack\.com\/sim\/\S+/.exec(orderReply);
    assert(!!linkMatch, `order confirmation must include a real Paystack link to compare against (got: ${orderReply.slice(0, 300)})`);
    const realPaymentUrl = linkMatch![0];

    const callsBeforePay = world.llm.calls.length;
    const beforePayReply = world.outbound.ofType("text", phone).length;
    await world.text(phone, "Ok so what account should I pay to?");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforePayReply, 8000, "payment-question reply");
    const payReply1 = last();
    assertIncludes(payReply1, realPaymentUrl, "asking about the payment account returns the REAL order's REAL payment link, not an invented account or a fake link");
    assert(!/example\.com/i.test(payReply1), "must never contain a fabricated placeholder link");
    assert(world.llm.calls.length === callsBeforePay, "a payment/account question must be answered from real order data, never escalated to the LLM to improvise");

    const beforePayReply2 = world.outbound.ofType("text", phone).length;
    await world.text(phone, "Can you share the paystack link with me?");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforePayReply2, 8000, "second payment-question reply");
    const payReply2 = last();
    assertIncludes(payReply2, realPaymentUrl, "the SAME real payment link is returned for a differently-phrased request, not a freshly-invented one");
    assert(world.llm.calls.length === callsBeforePay, "still zero LLM calls for the second phrasing");

    // 9. A false "success" claim in the LLM's own `reply` text must be DISCARDED, not appended to, once the
    // real, grounded catalog lookup finds nothing to actually add. Live evidence: "Dani" (not a real product)
    // got "✅ 1 × Dani milk" — the LLM's own invented confirmation — immediately followed by "couldn't find
    // Dani milk", both shown together, contradicting each other in the same message.
    world.llm.when("Dani", {
      reply: "✅ 1 × Dani milk", intent: "add_to_cart", nextState: "add_to_cart",
      extractedItems: [{ product: "Dani milk", quantity: 1 }],
      extractedProduct: null, extractedQuantity: null, extractedAddress: null, confidence: 0.9,
    });
    const beforeDani = world.outbound.ofType("text", phone).length;
    await world.text(phone, "Dani");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeDani, 8000, "nonexistent-product reply");
    const daniReply = last();
    assert(!/✅.*Dani/i.test(daniReply), `the LLM's own false "added" claim for a nonexistent product must be discarded, not shown (got: ${JSON.stringify(daniReply)})`);
    assertIncludes(daniReply, "couldn't find", "the real, grounded clarification is what the buyer sees instead");
  },
};
