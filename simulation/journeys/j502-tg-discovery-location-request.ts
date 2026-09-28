/**
 * === W50 CHANNELS (Coder A) ===
 * J502 — Channel-aware discovery prompt: a TG "…near me" search with NO pin
 * sends the native request_location reply keyboard (NOT the WA-only
 * "tap 📎 → Location" instruction).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J502",
  name: "telegram discovery ask uses the request_location keyboard",
  feature: "W50 discovery parity: channel-aware location prompt (TG)",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    const chatId = "880502";
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    await (await import("../../server/services/i18n")).setStickyLocale(TENANT_ID, `telegram:${chatId}`, "en");
    // Pre-create the nlp session as English (nlp's legacy substring detector
    // would otherwise tag "…me" messages igbo at session-creation time).
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.nlpSessions).values({
      tenantId: TENANT_ID, waPhoneNumber: `telegram:${chatId}`, language: "english", context: {},
    }).onConflictDoNothing();

    const before = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970503,
      message: { message_id: 1503, from: { id: 770502, first_name: "Loc" }, chat: { id: Number(chatId), type: "private" }, date: 1788000503, text: "pharmacy near me" },
    });
    assert(res.status === 200, `webhook ack 200 (got ${res.status})`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "location request sent");
    const sent = tg.callsFor("sendMessage").at(-1)!;
    const keyboard = sent.body?.reply_markup?.keyboard ?? [];
    assert(keyboard[0]?.[0]?.request_location === true, "TG gets the native request_location keyboard");
    const text = String(sent.body?.text ?? "");
    assert(!text.includes("📎"), "no WA-only 📎 instruction on Telegram");
    // Text is the localized discoveryAskLocationTelegram catalog entry.
    const { MESSAGE_CATALOG } = await import("../../server/services/i18n");
    const expected = Object.values(MESSAGE_CATALOG)
      .map((c) => c.discoveryAskLocationTelegram)
      .filter((v): v is string => !!v);
    assert(expected.includes(text), `localized TG location ask (got: ${text.slice(0, 160)})`);
  },
};
