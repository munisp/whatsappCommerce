/**
 * === W50 CHANNELS (Coder A) ===
 * J505 — Distance-first sort (B3) + per-result Google Maps links (B4):
 * with settings.discovery.sortBy default (distance), the closer merchant
 * outranks; each row carries https://maps.google.com/?q=lat,lng and the
 * footer hints sharing a different location.
 */
import { assert, SUPPLIER_TENANT_ID, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";
import { resetGeoDiscovery, seedDiscoverableMerchant } from "./helpers";

const PIN = { lat: 6.5244, lng: 3.3792 };

export const journey: Journey = {
  id: "J505",
  name: "discovery distance-first sort + Google Maps links",
  feature: "W50 discovery accuracy: sortBy distance + maps links + hint",
  async run(world: World) {
    await resetGeoDiscovery(world);
    // Far merchant = the main tenant (~3.0 km north), near = supplier (~0.5 km).
    await seedDiscoverableMerchant(world, TENANT_ID, {
      lat: PIN.lat + 0.027, lng: PIN.lng, category: "Food", productName: "W50 Far Kitchen",
    });
    await seedDiscoverableMerchant(world, SUPPLIER_TENANT_ID, {
      lat: PIN.lat + 0.0045, lng: PIN.lng, category: "Food", productName: "W50 Near Kitchen",
    });
    await ensureTelegramConfig(world);
    const schema = await import("../../drizzle/schema");
    const { recordConsent } = await import("../../server/services/consent");
    const { tg } = await import("../metaMock");

    const chatId = "880505";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    await (await import("../../server/services/i18n")).setStickyLocale(TENANT_ID, `telegram:${chatId}`, "en");
    await world.db.insert(schema.nlpSessions).values({
      tenantId: TENANT_ID,
      waPhoneNumber: `telegram:${chatId}`,
      context: { lastDiscovery: { lat: PIN.lat, lng: PIN.lng } },
    }).onConflictDoNothing();

    const before = tg.callsFor("sendMessage").length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970530,
      message: { message_id: 1530, from: { id: 770505, first_name: "Dist" }, chat: { id: Number(chatId), type: "private" }, date: 1788000505, text: "food near me" },
    });
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "discovery reply");
    const reply = String(tg.callsFor("sendMessage").at(-1)?.body?.text ?? "");

    assert(reply.includes("within 5 km"), `header carries the radius (got: ${reply.slice(0, 80)})`);
    assert(reply.includes("https://maps.google.com/?q="), "each result carries a Google Maps link");
    assert(/Share a different location/i.test(reply), "footer hints re-centering");
    // Distance-first: the ~0.5 km merchant ranks above the ~3.0 km one.
    const nearIdx = reply.indexOf("Lagos Plastics"); // supplier = near
    const farIdx = reply.indexOf("Sim Store"); // main tenant = far
    assert(nearIdx >= 0 && farIdx >= 0, "both merchants listed");
    assert(nearIdx < farIdx, "closer merchant ranks first (distance sort)");
  },
};
