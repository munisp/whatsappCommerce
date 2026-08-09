/**
 * J25 — Read receipts: every accepted inbound message produces a
 * markMessageRead POST (status:"read") against the real Cloud API path.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J25",
  name: "read receipts",
  feature: "markMessageRead POST",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    world.llm.when("blue ticks please", {
      reply: "Ticked!",
      intent: "greeting",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    await world.text(phone, "blue ticks please", { id: "wamid.sim.readreceipt.001" });

    const reads = world.outbound.ofType("read_receipt");
    assert(reads.length >= 1, "mark-read POST observed on the mock");
    const mine = reads.find((c) => c.body?.message_id === "wamid.sim.readreceipt.001");
    assert(mine, "mark-read references the inbound wamid");
    assert(mine!.body?.status === "read", "mark-read payload has status=read");
    assert(mine!.method === "POST" && mine!.url.includes("/messages"), "mark-read hits POST /{phoneId}/messages");
  },
};
