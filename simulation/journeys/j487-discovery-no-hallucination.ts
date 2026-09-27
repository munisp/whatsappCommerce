/**
 * J487 — QA-065: a "what's near me" question with no known location must NEVER be answered by the free-chat LLM
 * making up real-world business names.
 *
 * Found live 2026-09-26: a customer asked "What fast food restaurant is around me?", correctly got the "share
 * your location" prompt, but then replied with a TYPED place name ("I'm currently at yaba") instead of an actual
 * location share. Nothing recognized that as a discovery follow-up (it doesn't say "near me", and there's still no
 * real pin), so it fell all the way through to the general LLM chat — which invented real-world restaurant names
 * (MacDonald's, KFC, Pizza Hut) that are not platform merchants at all. This repo has no text→coordinates
 * geocoder, so a typed place name genuinely cannot be turned into real results — the fix makes that exact reply
 * deterministic (server/routers/nlp.ts's `awaitingDiscoveryLocation` context flag), so it can never reach the LLM.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { resetGeoDiscovery } from "./helpers";

export const journey: Journey = {
  id: "J487",
  name: "QA-065 a typed place name after the location prompt never reaches the hallucinating LLM",
  feature: "server/routers/nlp.ts geo discovery: no-pin follow-up stays deterministic",
  async run(world: World) {
    await resetGeoDiscovery(world);
    const { llm } = await import("../metaMock");
    const phone = world.newPhone("j487");
    await world.grantConsent(phone);

    // 1. "near me" style question, no pin on file → the real, deterministic share-location prompt (which also
    //    records the awaitingDiscoveryLocation context flag read by the intercept exercised in step 2).
    await world.text(phone, "What fast food restaurant is around me?");
    const prompt = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(prompt, "share your current location", "no-pin prompt asks for a real location share");

    // 2. Customer replies with a TYPED place name, not a real location share — the exact live reproducer.
    const beforeCalls = llm.calls.length;
    const beforeOutbound = world.outbound.ofType("text", phone).length;
    await world.text(phone, "I'm currently at yaba");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > beforeOutbound, 20000, "reply to the typed place name");
    const reply = bodyText(world.outbound.lastOfType("text", phone));

    // 3. Deterministic, honest answer — never a fabricated business list, and NEVER an LLM call for this turn.
    assertIncludes(reply, "shared location pin", "asks again for a REAL location share, not typed text");
    assert(llm.calls.length === beforeCalls, `must stay fully deterministic — no LLM call for a typed place name (calls: ${llm.calls.length - beforeCalls})`);
    // The exact hallucinated names from the live report must never appear anywhere the bot could plausibly say them.
    for (const fake of ["MacDonald's", "McDonald's", "KFC", "Pizza Hut"]) {
      assert(!reply.includes(fake), `reply must not invent a real-world business name (found "${fake}" in: ${reply.slice(0, 200)})`);
    }

    // 4. The pending-pin flag is one-shot — a follow-up unrelated message doesn't keep getting hijacked forever.
    const before2 = world.outbound.ofType("text", phone).length;
    await world.text(phone, "never mind, show me the menu");
    await world.waitFor(() => world.outbound.ofType("text", phone).length > before2, 20000, "reply to the follow-up");
    const reply2 = bodyText(world.outbound.lastOfType("text", phone));
    assert(!reply2.includes("shared location pin"), `the one-shot flag must not re-fire on an unrelated later message (got: ${reply2.slice(0, 200)})`);
  },
};
