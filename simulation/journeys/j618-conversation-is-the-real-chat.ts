/**
 * J618 — the shop's Conversations page shows the real WhatsApp chat (user
 * report 2026-11-04: "they are different"). It used to rebuild chats from the
 * assistant's notes: no consent or menu turns, "I want to place an order"
 * instead of the "1" the customer typed, no buttons, invented times.
 */
import { TENANT_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J618",
  name: "Conversations shows the real chat",
  feature: "channel_messages written for every WhatsApp message in and out",
  async run(world: World) {
    const phone = world.newPhone("convlog");
    // The customer's real exchange: hi → consent → yes → menu → 1 → catalog → 1 → added.
    for (const t of ["hi", "yes", "1", "1"]) {
      await world.text(phone, t);
      await world.settle();
    }
    const caller = await tenantCaller(TENANT_ID);
    const msgs = (await caller.conversation.getMessages({ tenantId: TENANT_ID, customerPhone: phone, limit: 60 }))
      .slice().sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const lines = msgs.map((m: any) => `${m.direction === "inbound" ? "C" : "S"}: ${String(m.body).split("\n")[0].slice(0, 60)}`);
    const inbound = msgs.filter((m: any) => m.direction === "inbound").map((m: any) => m.body);
    assert(JSON.stringify(inbound) === JSON.stringify(["hi", "yes", "1", "1"]), `the customer's own words, in order (got ${JSON.stringify(inbound)})`);
    assert(!inbound.some((b: string) => /place an order/i.test(b)), "no internal hand-off text shown as the customer's");
    const all = msgs.map((m: any) => String(m.body)).join("\n");
    assertIncludes(all, "consent", `the consent question is shown (${lines.join(" | ")})`);
    assertIncludes(all, "How can we help", "the welcome menu is shown");
    assertIncludes(all, "Cart: 1 item", "the add-to-cart reply is shown as sent, with the cart total");
    assertIncludes(all, "[🧾 Checkout]", "its buttons are shown");
    const ids = new Set(msgs.map((m: any) => m.id));
    assert(![...ids].some((id) => String(id).includes(":")), "no reconstructed rows when the real chat is recorded");
  },
};
