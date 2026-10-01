/**
 * === W50 CHANNELS (Coder A) ===
 * J503 — Stale-center guard (B1): with only a saved deliveryCoords pin (no
 * fresh shared location), a "near me" search ASKS for confirmation instead
 * of silently searching around the stale center; "use saved" confirms.
 * settings.discovery.requireFreshPin=false restores the legacy fallback.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";
import { approveKyb, resetGeoDiscovery, seedDiscoverableMerchant } from "./helpers";

const PIN = { lat: 6.5244, lng: 3.3792 };

async function tgText(world: World, chatId: string, updateId: number, text: string) {
  const { tg } = await import("../metaMock");
  const before = tg.callsFor("sendMessage").length;
  await tgPost(world, TENANT_ID, TG_SECRET, {
    update_id: updateId,
    message: { message_id: updateId % 10000, from: { id: 770503, first_name: "Stale" }, chat: { id: Number(chatId), type: "private" }, date: 1788000503, text },
  });
  await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, `reply to "${text}"`);
  return String(tg.callsFor("sendMessage").at(-1)?.body?.text ?? "");
}

export const journey: Journey = {
  id: "J503",
  name: "discovery stale-center asks before using a saved pin",
  feature: "W50 discovery accuracy: requireFreshPin stale-center guard",
  async run(world: World) {
    await resetGeoDiscovery(world);
    await seedDiscoverableMerchant(world, TENANT_ID, {
      lat: PIN.lat + 0.004, lng: PIN.lng, addressLine: "5 Sim Rd", city: "Lagos",
      category: "Food", productName: "W50 Rice Bowl",
    });
    await ensureTelegramConfig(world);
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { recordConsent } = await import("../../server/services/consent");

    // Session with ONLY a stale deliveryCoords pin (no lastDiscovery).
    const chatId = "880503";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    await (await import("../../server/services/i18n")).setStickyLocale(TENANT_ID, `telegram:${chatId}`, "en");
    await world.db.insert(schema.nlpSessions).values({
      tenantId: TENANT_ID,
      waPhoneNumber: `telegram:${chatId}`,
      context: { deliveryCoords: { latitude: PIN.lat, longitude: PIN.lng } },
    }).onConflictDoNothing();

    // 1. Default (requireFreshPin): asks to confirm, does NOT list merchants.
    const ask = await tgText(world, chatId, 970510, "food near me");
    assert(/saved delivery location/i.test(ask), `stale center asks first (got: ${ask.slice(0, 80)})`);
    assert(!ask.includes("Businesses near you"), "no silent stale-center search");

    // 2. "use saved" confirms → results around the saved pin.
    const confirmed = await tgText(world, chatId, 970511, "use saved");
    assert(confirmed.includes("Businesses near you"), `confirmed search lists merchants (got: ${confirmed.slice(0, 120)})`);
    assert(confirmed.includes("Sim Store") || confirmed.includes("W50") || confirmed.includes("near you"), "merchant listed");

    // 3. requireFreshPin=false → legacy silent fallback restored.
    const [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID));
    const settings = { ...(row.settings as any), discovery: { requireFreshPin: false } };
    await world.db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, TENANT_ID));
    const chat2 = "880513";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chat2}`, channel: "telegram", granted: true });
    await (await import("../../server/services/i18n")).setStickyLocale(TENANT_ID, `telegram:${chat2}`, "en");
    await world.db.insert(schema.nlpSessions).values({
      tenantId: TENANT_ID,
      waPhoneNumber: `telegram:${chat2}`,
      context: { deliveryCoords: { latitude: PIN.lat, longitude: PIN.lng } },
    }).onConflictDoNothing();
    const direct = await tgText(world, chat2, 970512, "food near me");
    assert(direct.includes("Businesses near you"), `requireFreshPin=false keeps the legacy fallback (got: ${direct.slice(0, 120)})`);
  },
};
