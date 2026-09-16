/**
 * === W37 telegram (Coder B) ===
 * J239 — session-key normalization: telegram identity isolation.
 *
 *  1. sessionKeyFor: whatsapp (and absent channel) returns the id unchanged
 *     (WA byte-equivalent); telegram → `telegram:<chat_id>` (idempotent on
 *     already-prefixed ids).
 *  2. A Telegram chat bound (via self contact-share) to the SAME phone that
 *     has a WhatsApp NLP session still gets its OWN session row keyed
 *     `telegram:<chat_id>` — the two identities never share session state.
 *  3. The WA session row is untouched by the Telegram conversation (no
 *     regression to the WA path).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

async function sessionRows(world: World, key: string): Promise<any[]> {
  const r = await world.pg.query(
    `SELECT "waPhoneNumber", "messageHistory" FROM nlp_sessions WHERE "tenantId" = $1 AND "waPhoneNumber" = $2`,
    [TENANT_ID, key],
  );
  return ((r as any).rows ?? r) as any[];
}

export const journey: Journey = {
  id: "J239",
  name: "telegram session-key normalization (tg identity isolated from wa identity of same phone)",
  feature: "W37 telegram channel identity",
  async run(world: World) {
    const { sessionKeyFor, channelFromSessionKey } = await import("../../server/services/channelIdentity");
    const { recordConsent } = await import("../../server/services/consent");
    await ensureTelegramConfig(world);

    // 1. Pure normalization.
    assert(sessionKeyFor("whatsapp", "2348010000001") === "2348010000001", "wa session key unchanged");
    assert(sessionKeyFor(undefined, "2348010000001") === "2348010000001", "absent channel = wa default");
    assert(sessionKeyFor(null, "2348010000001") === "2348010000001", "null channel = wa default");
    assert(sessionKeyFor("telegram", "880241") === "telegram:880241", "tg session key namespaced");
    assert(sessionKeyFor("telegram", "telegram:880241") === "telegram:880241", "tg session key idempotent");
    const parsed = channelFromSessionKey("telegram:880241");
    assert(parsed.channel === "telegram" && parsed.id === "880241", "channelFromSessionKey inverse");

    // 2. WA session for the phone (real WA webhook path).
    const phone = world.newPhone("w");
    await world.grantConsent(phone);
    // A non-menu message reaches the NLP fallback, which creates the session.
    await world.text(phone, "zzqx do you deliver to Yaba on Sundays", { profileName: "WA User" });
    await world.waitFor(async () => (await sessionRows(world, phone)).length === 1, 30000, "wa nlp session");
    const waRowsBefore = await sessionRows(world, phone);
    assert(waRowsBefore.length === 1, "wa session row keyed by raw phone");

    // Telegram chat bound to the SAME phone via self contact-share.
    const chatId = "880241";
    const fromId = 770241;
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    const bind = await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970244,
      message: {
        message_id: 9702440,
        from: { id: fromId, first_name: "Tg", username: "tguser241" },
        chat: { id: Number(chatId), type: "private" },
        date: 1788000000,
        contact: { phone_number: phone, first_name: "Tg", user_id: fromId },
      },
    });
    assert(bind.status === 200, "binding must ack 200");
    await world.waitFor(async () => {
      const r = await world.pg.query(
        `SELECT phone_e164 FROM telegram_identities WHERE tenant_id = $1 AND chat_id = $2`,
        [TENANT_ID, chatId],
      );
      const rows = ((r as any).rows ?? r) as any[];
      return rows[0]?.phone_e164 === phone;
    }, 5000, "identity bound to same phone");

    // Telegram conversation → its own session row, keyed telegram:<chat_id>.
    const res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970245, chatId, fromId, "hi from telegram"));
    assert(res.status === 200, "telegram text must ack 200");
    await world.waitFor(async () => (await sessionRows(world, `telegram:${chatId}`)).length === 1, 8000, "tg nlp session");

    const tgRows = await sessionRows(world, `telegram:${chatId}`);
    assert(tgRows.length === 1, "telegram session keyed telegram:<chat_id>");
    const waRowsAfter = await sessionRows(world, phone);
    assert(waRowsAfter.length === 1, "wa session row still distinct (no merge)");
    const waHistory = JSON.stringify(waRowsAfter[0].messageHistory ?? []);
    assert(!waHistory.includes("hi from telegram"), "telegram message must NOT leak into the wa session");
    const tgHistory = JSON.stringify(tgRows[0].messageHistory ?? []);
    assert(tgHistory.includes("hi from telegram"), "telegram session holds its own history");
  },
};
