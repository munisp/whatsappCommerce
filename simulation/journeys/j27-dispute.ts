/**
 * J27 — Dispute: "I have a complaint about my order" → dispute logged +
 * buyer confirmation + admin alert referencing the order.
 */
import { ADMIN_PHONE, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J27",
  name: "dispute intake",
  feature: "chatDispute + admin alert",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });

    world.llm.when("I have a complaint about my order", {
      reply: "(overridden by the dispute handler)",
      intent: "dispute",
      nextState: "support",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    const adminBase = world.outbound.toPhone(ADMIN_PHONE).length;
    await world.text(phone, "I have a complaint about my order — it never arrived");

    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "complaint", "buyer gets a dispute confirmation");
    assertIncludes(reply, "dispute", "reply confirms a dispute was logged");
    assertIncludes(reply, order.orderNumber, "dispute references the buyer's latest order");

    await world.waitFor(() => world.outbound.toPhone(ADMIN_PHONE).length > adminBase, 8000, "admin dispute alert sent");
    const adminMsg = bodyText(world.outbound.toPhone(ADMIN_PHONE)[adminBase]);
    assertIncludes(adminMsg, order.orderNumber, "admin alert references the order");
    assert(/dispute|complaint/i.test(adminMsg), "admin alert describes the dispute");

    // Complaint with no order history still logs + reassures.
    const phone2 = world.newPhone("b");
    await world.grantConsent(phone2);
    world.llm.when("I have a complaint about my order", {
      reply: "(overridden by the dispute handler)",
      intent: "dispute",
      nextState: "support",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.95,
    });
    await world.text(phone2, "I have a complaint about my order");
    const reply2 = bodyText(world.outbound.lastOfType("text", phone2));
    assertIncludes(reply2, "logged your complaint", "no-order complaint still logged");
    assertIncludes(reply2, "share your order number", "no-order complaint asks for the order number");
  },
};
