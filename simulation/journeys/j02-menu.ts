/**
 * J2 — Conversational menu. "menu" → interactive (button/list) payload with
 * tenant labels, not a plain-text dump; numeric selection resolves entries.
 */
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J02",
  name: "interactive menu",
  feature: "waMenu interactive rendering",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    await world.text(phone, "menu");
    const interactive = world.outbound.lastOfType("interactive", phone);
    assert(interactive, "menu is delivered as an interactive payload (not plain text)");
    const iv = interactive.body?.interactive;
    assert(iv && (iv.type === "button" || iv.type === "list"), `interactive type is button|list (got ${iv?.type})`);
    const serialized = JSON.stringify(iv);
    assertIncludes(serialized, "Shop products", "menu shows the tenant shop label");
    assertIncludes(serialized, "Track my order", "menu shows the track label");

    // The plain-text fallback should NOT have been sent for the menu itself.
    const texts = world.outbound.ofType("text", phone);
    const menuTextDump = texts.filter((t) => bodyTextStr(t).includes("Reply with a number"));
    assert(menuTextDump.length === 0, "no plain-text menu dump when interactive send succeeds");

    // Interactive selection via a list/button reply id resolves like "1".
    const replyId = iv.type === "button"
      ? iv.action?.buttons?.[0]?.reply?.id
      : iv.action?.sections?.[0]?.rows?.[0]?.id;
    assert(typeof replyId === "string" && replyId.length > 0, "first menu entry has a reply id");

    world.llm.when("I want to place an order", {
      reply: "Sure — what would you like? We have Jollof Rice and more.",
      intent: "browse",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.buttonReply(phone, replyId!, "Shop products");
    const reply = world.outbound.lastOfType("text", phone);
    assert(reply, "shop selection produced a reply");
    assertIncludes(replyText(reply), "Jollof Rice", "shop entry hands off to the NLP shop flow");
  },
};

function bodyTextStr(call: { body: any }): string {
  return String(call?.body?.text?.body ?? "");
}
function replyText(call: { body: any } | undefined): string {
  return String(call?.body?.text?.body ?? "");
}
