/**
 * J616 — shop setup from the shared platform number (user report 2026-11-04:
 * "users can't create shops through WhatsApp"). Real messages that got a shop
 * search instead: "I want to create a store", "How do I create a shop", "SELL".
 *
 *   sell intent        → the onboarding assistant answers, FROM the shared number
 *   next message       → still the assistant (not the shop directory)
 *   "home"             → leaves setup (saved); buyers' searches work again
 *   "SELL"             → resumes the same setup, no second session
 */
import { assert, bodyText, type World } from "../world";
import * as payloads from "../payloads";
import type { Journey } from "../runner";
import { onboardingSessionByPhone } from "./helpers";

const PLATFORM_PN = "pn_sim_platform_616";

export const journey: Journey = {
  id: "J616",
  name: "shared number: create a shop by chat",
  feature: "SELL / 'create a shop' on the shared number → onboarding assistant",
  async run(world: World) {
    const pn = await import("../../server/services/platformNumber");
    process.env.WHATSAPP_PLATFORM_NUMBER_ID = PLATFORM_PN;
    process.env.WHATSAPP_PLATFORM_TOKEN = "sim-platform-token-616";
    pn.__clearActiveShopMemory();
    const owner = world.newPhone("seller");
    const viaPlatform = (c: any) => !!c && new URL(c.url).pathname.includes(PLATFORM_PN);
    try {
      // 1. "I want to create a store" → the assistant, from the shared number.
      await world.inbound(payloads.inbound.text(PLATFORM_PN, owner, "I want to create a store", { profileName: "Ada" }));
      await world.settle();
      const first = world.outbound.lastTo(owner);
      assert(viaPlatform(first), "the assistant answers from the shared number");
      assert(/onboarding assistant/i.test(bodyText(first)), `greeting from the onboarding assistant (got: ${bodyText(first).slice(0, 160)})`);
      assert(!/couldn't find a store|No store near you/i.test(bodyText(first)), "not treated as a shop search");
      const s1 = await onboardingSessionByPhone(owner);
      assert(s1, "a shop setup was started");
      assert((await pn.getSelling(owner)) === "1", "the owner is in shop setup");

      // 2. The next message stays with the assistant.
      const before = world.outbound.toPhone(owner).length;
      await world.inbound(payloads.inbound.text(PLATFORM_PN, owner, "Ada Fabrics, I sell ankara in Lagos"));
      await world.settle();
      const next = world.outbound.toPhone(owner).slice(before);
      assert(next.length > 0 && next.every(viaPlatform), "the assistant replies to the next message too, from the shared number");
      assert(!next.some((c) => /Stores near you|send your 📎 \*location\*|No store near you/i.test(bodyText(c))), "the shop directory stays out of the setup");

      // 3. "home" leaves setup; a buyer search works again.
      await world.inbound(payloads.inbound.text(PLATFORM_PN, owner, "home"));
      await world.settle();
      assert(/left shop setup/i.test(bodyText(world.outbound.lastTo(owner))), "home leaves shop setup (and says it's saved)");
      assert((await pn.getSelling(owner)) == null, "no longer in shop setup");
      await world.inbound(payloads.inbound.text(PLATFORM_PN, owner, "Perfume"));
      await world.settle();
      assert(/location/i.test(bodyText(world.outbound.lastTo(owner))), "a product search goes to the directory again");

      // 4. "SELL" resumes the same setup.
      await world.inbound(payloads.inbound.text(PLATFORM_PN, owner, "SELL"));
      await world.settle();
      assert(viaPlatform(world.outbound.lastTo(owner)), "SELL answered by the assistant");
      const s2 = await onboardingSessionByPhone(owner);
      assert(s2 && s2.id === s1!.id, `SELL resumed the same setup (got ${s2?.id} vs ${s1!.id})`);
    } finally {
      delete process.env.WHATSAPP_PLATFORM_NUMBER_ID;
      delete process.env.WHATSAPP_PLATFORM_TOKEN;
      pn.__clearActiveShopMemory();
    }
  },
};
