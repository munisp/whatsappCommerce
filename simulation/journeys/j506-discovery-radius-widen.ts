/**
 * === W50 CHANNELS (Coder A) ===
 * J506 — Radius auto-widen (B5): a "near me" search with an empty 5 km
 * page retries at ×2 radius (10 km ≤ maxRadiusKm) and discloses the
 * expansion in the reply.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";
import { resetGeoDiscovery, seedDiscoverableMerchant } from "./helpers";

const PIN = { lat: 6.5244, lng: 3.3792 };

export const journey: Journey = {
  id: "J506",
  name: "discovery radius auto-widens on empty results",
  feature: "W50 discovery accuracy: radius ×2 widening with disclosure",
  async run(world: World) {
    await resetGeoDiscovery(world);
    // Only merchant sits ~8 km out — outside the 5 km default, inside 10 km.
    await seedDiscoverableMerchant(world, TENANT_ID, {
      lat: PIN.lat + 0.072, lng: PIN.lng, serviceRadiusKm: 50,
      category: "Food", productName: "W50 Far Grill",
    });
    await ensureTelegramConfig(world);
    const schema = await import("../../drizzle/schema");
    const { recordConsent } = await import("../../server/services/consent");
    const { tg } = await import("../metaMock");

    const chatId = "880506";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    await (await import("../../server/services/i18n")).setStickyLocale(TENANT_ID, `telegram:${chatId}`, "en");
    await world.db.insert(schema.nlpSessions).values({
      tenantId: TENANT_ID,
      waPhoneNumber: `telegram:${chatId}`,
      context: { lastDiscovery: { lat: PIN.lat, lng: PIN.lng } },
    }).onConflictDoNothing();

    const before = tg.callsFor("sendMessage").length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970540,
      message: { message_id: 1540, from: { id: 770506, first_name: "Wide" }, chat: { id: Number(chatId), type: "private" }, date: 1788000506, text: "food near me" },
    });
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "widened discovery reply");
    const reply = String(tg.callsFor("sendMessage").at(-1)?.body?.text ?? "");
    assert(reply.includes("widened the search to 10 km"), `expansion disclosed (got: ${reply.slice(0, 120)})`);
    assert(reply.includes("Businesses near you"), "widened search lists the far merchant");
    assert(reply.includes("Sim Store"), "merchant appears after widening");
  },
};
