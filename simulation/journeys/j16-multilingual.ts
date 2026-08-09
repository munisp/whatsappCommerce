/**
 * J16 — Multilingual: French inbound → French menu/system replies, and the
 * locale sticks for later messages.
 */
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J16",
  name: "multilingual (fr, sticky)",
  feature: "i18n detect + sticky locale",
  async run(world) {
    // ── First contact in French → French consent prompt + grant ──────────
    const phone = world.newPhone("a");
    await world.text(phone, "bonjour, je voudrais passer une commande svp");
    const prompt = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(prompt, "Répondez OUI", "first contact in French gets the French consent prompt");

    await world.text(phone, "OUI");
    const granted = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(granted, "Merci", "French consent grant acknowledgement");
    assertIncludes(granted, "Acheter", "menu after grant is in French");

    // ── Sticky: a neutral "menu" later still renders French ──────────────
    await world.text(phone, "menu");
    const interactive = world.outbound.lastOfType("interactive", phone);
    assert(interactive, "menu sent interactively");
    const serialized = JSON.stringify(interactive.body?.interactive ?? {});
    assertIncludes(serialized, "Acheter / passer un", "sticky locale keeps the menu French");
    assertIncludes(serialized, "Suivre ma commande", "French track label present");

    // ── French system reply from the i18n pack (voice fail-soft) ─────────
    const { scriptMedia } = await import("../metaMock");
    delete process.env.OPENAI_API_KEY;
    scriptMedia("m-voice-fr", "fake-ogg", "audio/ogg");
    await world.audio(phone, "m-voice-fr");
    await world.waitFor(() => {
      const t = bodyText(world.outbound.lastOfType("text", phone));
      return t.includes("notes vocales") || t.includes("🎤");
    }, 8000, "French voice fail-soft reply");
    const soft = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(soft, "notes vocales ne sont pas activées", "voice fail-soft localized to French");
  },
};
