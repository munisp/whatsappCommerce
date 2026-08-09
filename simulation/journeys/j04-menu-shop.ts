/**
 * J4 — Menu-driven shop: numeric selection "1" after the menu launches the
 * shop flow; follow-up text routes through the NLP pipeline (search → card).
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J04",
  name: "menu-driven shop",
  feature: "numeric menu selection → shop flow",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    await world.text(phone, "menu");
    assert(world.outbound.lastOfType("interactive", phone), "menu rendered interactively");

    // Numeric selection 1 = Shop products (default use-case order).
    world.llm.when("I want to place an order", {
      reply: "Great — tell me what you want, e.g. '2 Jollof Rice'.",
      intent: "browse",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "1");
    const shopReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(shopReply, "Jollof Rice", "numeric menu selection enters the shop flow");

    // Follow-up text goes through the NLP pipeline (search → product card).
    world.llm.when("show me ankara", {
      reply: "Here is our Ankara Fabric!",
      intent: "search",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: "Ankara Fabric",
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "show me ankara");
    const searchReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(searchReply, "Ankara Fabric", "NLP search reply mentions the product");
    const imageCard = world.outbound.lastOfType("image", phone);
    assert(imageCard, "product card sent as a WhatsApp image message");
    assertIncludes(JSON.stringify(imageCard?.body), "https://cdn.sim.local/ankara.jpg", "product card uses the catalog image URL");
  },
};
