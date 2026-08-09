/**
 * J1 — NDPR consent capture. First-ever inbound → opt-in prompt; YES (and
 * French OUI) → consents row granted; menu follows the grant.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";

async function consentRow(world: World, phone: string) {
  const schema = await import("../../drizzle/schema");
  const [row] = await world.db
    .select()
    .from(schema.consents)
    .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone)))
    .limit(1);
  return row ?? null;
}

export const journey: Journey = {
  id: "J01",
  name: "consent opt-in",
  feature: "NDPR consent gate",
  async run(world) {
    // ── English YES path ─────────────────────────────────────────────────
    const phone = world.newPhone("a");
    await world.text(phone, "hello there");
    const prompt = world.outbound.lastOfType("text", phone);
    assert(prompt, "first-ever inbound produced a reply");
    assertIncludes(bodyText(prompt), "NDPR", "opt-in prompt mentions NDPR");
    assertIncludes(bodyText(prompt), "Reply YES", "opt-in prompt asks for YES/NO");
    assert(!(await consentRow(world, phone)), "no consent row before the YES reply");

    await world.text(phone, "YES");
    const granted = await consentRow(world, phone);
    assert(granted?.granted === true, "consents row granted after YES");
    const afterYes = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(afterYes, "opted in", "grant confirmation reply");
    assertIncludes(afterYes, "Welcome to Sim Store", "menu is shown right after consent");

    // ── French OUI path ──────────────────────────────────────────────────
    const phoneFr = world.newPhone("b");
    await world.text(phoneFr, "bonjour");
    const frPrompt = bodyText(world.outbound.lastOfType("text", phoneFr));
    assert(frPrompt.includes("Répondez OUI") || frPrompt.includes("Reply YES"), "fr/ambiguous first contact still prompts for consent");
    await world.text(phoneFr, "OUI");
    const frConsent = await consentRow(world, phoneFr);
    assert(frConsent?.granted === true, "consents row granted after OUI (fr)");

    // ── NO path: opted out, can still chat ───────────────────────────────
    const phoneNo = world.newPhone("c");
    await world.text(phoneNo, "hi");
    await world.text(phoneNo, "NO");
    const denied = await consentRow(world, phoneNo);
    assert(denied && denied.granted === false, "consents row records opt-out after NO");
    assertIncludes(bodyText(world.outbound.lastOfType("text", phoneNo)), "opted out", "opt-out confirmation reply");
  },
};
