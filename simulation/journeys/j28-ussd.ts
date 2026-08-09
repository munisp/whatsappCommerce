/**
 * J28 — USSD: Africa's Talking POST /ussd drives the same menu/session
 * engine — CON menus, numeric navigation, END termination.
 */
import { assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J28",
  name: "USSD session",
  feature: "/ussd CON/END engine",
  async run(world) {
    const phone = world.newPhone("a");
    const sessionId = `ussd-${Date.now()}`;

    // Initial dial → CON menu with tenant entries.
    const menu = await world.ussd(sessionId, phone, "");
    assert(menu.startsWith("CON"), `initial dial continues (got ${menu.slice(0, 40)})`);
    assertIncludes(menu, "Shop products", "USSD menu lists shop");
    assertIncludes(menu, "Track my order", "USSD menu lists tracking");

    // Explicit menu keyword also shows the menu.
    const menu2 = await world.ussd(sessionId, phone, "menu");
    assert(menu2.startsWith("CON"), "menu keyword continues");

    // Numeric selection 1 → shop flow (CON while the flow continues).
    world.llm.when("I want to place an order", {
      reply: "What would you like? We have Jollof Rice and more.",
      intent: "browse",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.9,
    });
    const shop = await world.ussd(sessionId, phone, "1");
    assert(shop.startsWith("CON") || shop.startsWith("END"), "selection responds in USSD format");
    assertIncludes(shop, "Jollof Rice", "numeric nav enters the shop flow");

    // Track flow: numeric 2 → latest-order status (END — one-shot lookup).
    const track = await world.ussd(`${sessionId}-2`, phone, "2");
    assert(/^(CON|END)/.test(track), "track selection responds in USSD format");
    assertIncludes(track, "order", "track flow talks about orders");

    // Garbage input → menu re-shown (CON).
    const garbage = await world.ussd(sessionId, phone, "1*xyz-nonsense");
    assert(garbage.startsWith("CON"), "unknown input re-shows the menu with CON");

    // Missing session params → END error.
    const res = await fetch(`${world.baseUrl}/ussd`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ sessionId: "", phoneNumber: "", text: "" }).toString(),
    });
    const bad = await res.text();
    assert(bad.startsWith("END"), "malformed USSD request terminates with END");
  },
};
