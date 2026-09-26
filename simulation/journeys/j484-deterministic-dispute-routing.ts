/**
 * J484 — dispute-raising reaches the fast deterministic path, not just the LLM.
 *
 * Found live 2026-09-26 (user: "i can't see disputes"): raising a dispute via chat ("my order never
 * arrived") only ever worked through the LLM's `intent: "dispute"` output — it was never added to
 * classifyDeterministically when the deterministic-first reorder happened (QA-055 round 2), so the
 * single most consequential thing a buyer can say paid the LLM's full latency and depended on the least
 * reliable link in the pipeline. server/services/deterministicShop.ts now recognizes dispute-shaped
 * complaints directly (reusing chatDispute.ts's own reason-keyword phrasing as the trigger).
 */
import { ADMIN_PHONE, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { createChatOrderViaNlp } from "./helpers";

export const journey: Journey = {
  id: "J484",
  name: "deterministic-first dispute routing",
  feature: "deterministicShop.ts DISPUTE_RE + nlp.ts dispute handler (no LLM round trip)",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    const order = await createChatOrderViaNlp(world, phone, { items: [{ product: "Jollof Rice", quantity: 1 }] });

    // Deliberately NO world.llm.when(...) registered for the message below — if this ever falls through
    // to the LLM escalation path, the mock has no matching rule and the request either errors or returns
    // the mock's default, which would fail the assertions below. That absence is itself the test.
    const llmCallsBefore = world.llm.calls.length;
    const adminBase = world.outbound.toPhone(ADMIN_PHONE).length;
    await world.text(phone, "my order never arrived");

    assert(world.llm.calls.length === llmCallsBefore, "dispute-shaped complaint never reached the LLM — the deterministic classifier caught it");

    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "dispute", "reply confirms a dispute was logged");
    assertIncludes(reply, order.orderNumber, "dispute references the buyer's latest order");

    await world.waitFor(() => world.outbound.toPhone(ADMIN_PHONE).length > adminBase, 8000, "admin dispute alert sent");
    const adminMsg = bodyText(world.outbound.toPhone(ADMIN_PHONE)[adminBase]);
    assertIncludes(adminMsg, order.orderNumber, "admin alert references the order");

    // A second, differently-worded trigger ("wrong item") on a fresh session — proves the regex isn't
    // keyed to one exact phrase, still with zero LLM calls.
    const phone2 = world.newPhone("b");
    await world.grantConsent(phone2);
    const order2 = await createChatOrderViaNlp(world, phone2, { items: [{ product: "Grilled Chicken", quantity: 1 }] });
    const llmCallsBefore2 = world.llm.calls.length;
    await world.text(phone2, "you sent the wrong item");
    assert(world.llm.calls.length === llmCallsBefore2, "'wrong item' complaint also stayed on the deterministic path");
    const reply2 = bodyText(world.outbound.lastOfType("text", phone2));
    assertIncludes(reply2, order2.orderNumber, "second dispute also references its own order");
  },
};
