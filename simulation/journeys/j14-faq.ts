/**
 * J14 — FAQ: a question matching settings.faq is answered straight from the
 * knowledge base (no LLM call, no menu).
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J14",
  name: "FAQ direct answer",
  feature: "faq KB (no LLM)",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);

    const llmCallsBefore = world.llm.calls.length;
    await world.text(phone, "What are your opening hours?");
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "8am to 8pm", "FAQ answer comes from tenant settings.faq");
    assert(world.llm.calls.length === llmCallsBefore, "no LLM call spent on an FAQ hit");

    // Second FAQ entry also works.
    await world.text(phone, "Do you deliver to Abuja?");
    const reply2 = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply2, "Abuja", "second FAQ entry answered");
    assertIncludes(reply2, "2 days", "second FAQ answer content");

    // A non-FAQ question still falls through to the normal pipeline (LLM).
    await world.text(phone, "tell me something unrelated entirely");
    assert(world.llm.calls.length > llmCallsBefore, "non-FAQ text reaches the LLM pipeline");
  },
};
