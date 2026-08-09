/**
 * J17 — Visual search: a product photo (no pending receipt) → vision match
 * → product card; no match → menu fallback. The vision LLM is scripted via
 * the media bytes (SIMIMG product=<name>).
 */
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

/** Script the visual-search vision LLM from the (mock) image bytes. */
function scriptProductVision(world: World) {
  world.llm.when(
    (userText) => userText.includes("[image:"),
    (userText) => {
      const m = /\[image:data:[^;]+;base64,([^\]\s]+)/.exec(userText);
      let itemName = "";
      if (m) {
        const decoded = Buffer.from(m[1], "base64").toString("utf8");
        const p = /product=([^\]]+)/.exec(decoded);
        if (p) itemName = p[1].trim();
      }
      return { itemName, description: itemName ? `A photo of ${itemName}` : "Unidentifiable object" };
    },
  );
}

export const journey: Journey = {
  id: "J17",
  name: "visual product search",
  feature: "vision match → product card",
  async run(world) {
    const phone = world.newPhone("a");
    await world.grantConsent(phone);
    scriptProductVision(world);

    // ── Match: Ankara Fabric photo → product card ────────────────────────
    scriptMedia("m-photo-ankara", "SIMIMG product=Ankara Fabric");
    await world.image(phone, "m-photo-ankara");
    await world.waitFor(() => world.outbound.lastOfType("image", phone) != null, 10000, "product card sent");
    const card = world.outbound.lastOfType("image", phone);
    const cardStr = JSON.stringify(card?.body);
    assertIncludes(cardStr, "https://cdn.sim.local/ankara.jpg", "product card uses the catalog image");
    assertIncludes(cardStr, "Ankara Fabric", "product card caption names the match");
    assertIncludes(cardStr, "BUY", "product card tells the buyer how to order");

    // ── No match → polite fallback with the in-stock mini menu ───────────
    scriptMedia("m-photo-unknown", "SIMIMG product=Nonexistent Gadget");
    const before = world.outbound.toPhone(phone).length;
    await world.image(phone, "m-photo-unknown");
    await world.waitFor(() => world.outbound.toPhone(phone).length > before, 10000, "fallback reply sent");
    const fallback = world.outbound.toPhone(phone).slice(before).map((c) => bodyText(c)).join("\n");
    assertIncludes(fallback, "couldn't find that exact item", "no-match fallback copy");
    assertIncludes(fallback, "Jollof Rice", "fallback lists in-stock products");
  },
};
