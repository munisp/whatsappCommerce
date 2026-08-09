/**
 * J26 — Webhook dedupe: Meta redelivers the same wamid → the platform
 * processes it exactly once (no duplicate reply, no duplicate LLM call).
 */
import { PHONE_NUMBER_ID, assert, assertIncludes, bodyText, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J26",
  name: "webhook dedupe",
  feature: "wamid dedupe ledger",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    world.llm.when("dedupe check", {
      reply: "Processed once.",
      intent: "greeting",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });

    const wamid = "wamid.sim.dedupe.00001";
    const envelope = payloads.inbound.text(PHONE_NUMBER_ID, phone, "dedupe check", { id: wamid });

    // First delivery → processed.
    const code1 = await world.postWebhook(envelope);
    assert(code1 === 200, "first delivery acked");
    await world.settle();
    const replies1 = world.outbound.ofType("text", phone).length;
    const llmCalls1 = world.llm.calls.length;
    assert(replies1 === 1, "first delivery produced one reply");
    assertIncludes(bodyText(world.outbound.lastOfType("text", phone)), "Processed once", "reply content");

    // Meta redelivers the identical payload (same wamid) → must be skipped.
    const code2 = await world.postWebhook(envelope);
    assert(code2 === 200, "redelivery acked (Meta requires 200)");
    await world.settle();
    const replies2 = world.outbound.ofType("text", phone).length;
    assert(replies2 === replies1, "duplicate delivery produced NO second reply");
    assert(world.llm.calls.length === llmCalls1, "duplicate delivery did not reach the NLP/LLM pipeline");

    // A genuinely new message (different wamid) still processes.
    await world.text(phone, "dedupe check", { id: "wamid.sim.dedupe.00002" });
    assert(world.outbound.ofType("text", phone).length === replies1 + 1, "new wamid processes normally");
  },
};
