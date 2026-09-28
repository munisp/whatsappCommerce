/**
 * === W50 CHANNELS (Coder A) ===
 * J507 — USSD discovery-by-text (B6): USSD has no GPS pin; a "near me"
 * dial input prompts for a typed area, and the area string resolves against
 * the discoverable merchants' address fields (addressLine/city) with an
 * END list. A query that already names the area resolves in one step.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { resetGeoDiscovery, seedDiscoverableMerchant } from "./helpers";

const PIN = { lat: 6.5244, lng: 3.3792 };

export const journey: Journey = {
  id: "J507",
  name: "USSD discovery-by-text resolves typed areas",
  feature: "W50 USSD parity: discovery via area/landmark text",
  async run(world: World) {
    await resetGeoDiscovery(world);
    await seedDiscoverableMerchant(world, TENANT_ID, {
      lat: PIN.lat, lng: PIN.lng, addressLine: "12 Aminu Kano Crescent", city: "Wuse 2",
    });
    const phone = world.newPhone("507");
    const sessionId = `ussd-w50-${Date.now()}`;

    // 1. Bare discovery trigger → CON prompt asking for the area.
    const prompt = await world.ussd(sessionId, phone, "near me");
    assert(prompt.startsWith("CON"), `area prompt continues (got ${prompt.slice(0, 60)})`);
    assert(/area|landmark/i.test(prompt), "prompt asks for a typed area");

    // 2. Typed area resolves against merchantLocations address fields (END).
    const found = await world.ussd(sessionId, phone, "near me*wuse");
    assert(found.startsWith("END"), `result list terminates (got ${found.slice(0, 60)})`);
    assert(found.includes("Sim Store"), `merchant matched by area text (got: ${found.slice(0, 120)})`);
    assert(found.includes("Aminu Kano") || found.includes("Wuse"), "address/city shown");

    // 3. One-step: residual query names the area directly.
    const oneStep = await world.ussd(`${sessionId}-b`, world.newPhone("507b"), "food near me in aminu kano");
    assert(oneStep.includes("Sim Store"), `residual area resolves in one step (got: ${oneStep.slice(0, 120)})`);

    // 4. Unknown area → friendly END empty state (prompt first, same session).
    const phone4 = world.newPhone("507c");
    const sid4 = `${sessionId}-c`;
    await world.ussd(sid4, phone4, "near me"); // opens the area prompt
    const empty = await world.ussd(sid4, phone4, "near me*zzzz nowhere");
    assert(empty.startsWith("END"), `unknown area ends the session (got: ${empty.slice(0, 80)})`);
    assert(/no businesses/i.test(empty), "honest empty state");
  },
};
