/**
 * === W50 CHANNELS (Coder A) ===
 * J504 — Discovery query synonyms (B2): "chemist near me" matches a
 * Pharmacy-category merchant; pidgin "chop near me" matches a Food
 * merchant — through the live TG inbound → nlp discovery path.
 */
import { assert, SUPPLIER_TENANT_ID, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";
import { resetGeoDiscovery, seedDiscoverableMerchant } from "./helpers";

const PIN = { lat: 6.5244, lng: 3.3792 };

export const journey: Journey = {
  id: "J504",
  name: "discovery synonyms: chemist→pharmacy, chop→food (pidgin)",
  feature: "W50 discovery accuracy: query→category synonym map",
  async run(world: World) {
    await resetGeoDiscovery(world);
    await seedDiscoverableMerchant(world, TENANT_ID, {
      lat: PIN.lat + 0.003, lng: PIN.lng, category: "Pharmacy", productName: "W50 Paracetamol 500mg",
    });
    await seedDiscoverableMerchant(world, SUPPLIER_TENANT_ID, {
      lat: PIN.lat - 0.003, lng: PIN.lng, category: "Food", productName: "W50 Jollof Bowl",
    });
    await ensureTelegramConfig(world);
    const schema = await import("../../drizzle/schema");
    const { recordConsent } = await import("../../server/services/consent");
    const { tg } = await import("../metaMock");

    const chatId = "880504";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    await (await import("../../server/services/i18n")).setStickyLocale(TENANT_ID, `telegram:${chatId}`, "en");
    await world.db.insert(schema.nlpSessions).values({
      tenantId: TENANT_ID,
      waPhoneNumber: `telegram:${chatId}`,
      context: { lastDiscovery: { lat: PIN.lat, lng: PIN.lng } },
    }).onConflictDoNothing();

    async function ask(updateId: number, text: string): Promise<string> {
      const before = tg.callsFor("sendMessage").length;
      await tgPost(world, TENANT_ID, TG_SECRET, {
        update_id: updateId,
        message: { message_id: updateId % 10000, from: { id: 770504, first_name: "Syn" }, chat: { id: Number(chatId), type: "private" }, date: 1788000504, text },
      });
      await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, `reply to "${text}"`);
      return String(tg.callsFor("sendMessage").at(-1)?.body?.text ?? "");
    }

    // "chemist" has no literal match — the synonym map must bridge to Pharmacy.
    const chemist = await ask(970520, "chemist near me");
    assert(chemist.includes("Businesses near you"), `chemist matches via synonym (got: ${chemist.slice(0, 120)})`);
    assert(chemist.includes("Sim Store"), "pharmacy merchant surfaced via synonym");
    assert(!/lagos plastics/i.test(chemist), "food merchant not matched by 'chemist'");

    // Pidgin "chop" bridges to food/eatery categories.
    const chop = await ask(970521, "chop near me");
    assert(chop.includes("Businesses near you"), `chop resolves (got: ${chop.slice(0, 120)})`);
    assert(/lagos plastics/i.test(chop), `pidgin 'chop' matches the food merchant (got: ${chop.slice(0, 160)})`);
    assert(!/paracetamol|sim store/i.test(chop), "pharmacy merchant not matched by 'chop'");
  },
};
