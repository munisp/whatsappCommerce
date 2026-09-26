/**
 * === W37 telegram (Coder B) ===
 * J238 — /start opt-in and /stop + "STOP" revocation (consent.ts W37 seam).
 *
 * Telegram implements STOP correctly from day one:
 *  1. /start records a granted consent row keyed (tenant, telegram:<chat>,
 *     channel='telegram') and sends the opt-in confirmation.
 *  2. Plain-text "STOP" revokes: granted=false + withdrawnAt stamped, the
 *     stop confirmation goes out, and hasChannelConsent reports false —
 *     the revocation is honored on subsequent inbound/proactive checks.
 *  3. /stop (command form) revokes too, even with no prior row.
 *  4. /start after revocation re-opts-in (withdrawnAt cleared).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

async function consentRow(world: World, sessionKey: string): Promise<any | null> {
  const r = await world.pg.query(
    `SELECT granted, withdrawn_at, channel FROM consents WHERE tenant_id = $1 AND phone = $2 AND channel = 'telegram' ORDER BY created_at DESC LIMIT 1`,
    [TENANT_ID, sessionKey],
  );
  const rows = ((r as any).rows ?? r) as any[];
  return rows[0] ?? null;
}

export const journey: Journey = {
  id: "J238",
  name: "telegram /start opt-in + /stop and STOP revocation",
  feature: "W37 telegram consent seam",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    const { hasChannelConsent, CONSENT_CHANNEL_TELEGRAM } = await import("../../server/services/consent");
    await ensureTelegramConfig(world);

    const chatId = "880239";
    const fromId = 770239;
    const key = `telegram:${chatId}`;

    // 1. /start → opt-in. Two sends follow, not one: the opt-in confirmation, then the welcome menu in the same
    //    turn (WA parity). Wait for both, or the menu's slower DB-bound send can still be in flight when step 2
    //    posts STOP right after — landing late and being mistaken for the stop confirmation below.
    let before = tg.callsFor("sendMessage").length;
    let res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970240, chatId, fromId, "/start"));
    assert(res.status === 200, "start must ack 200");
    await world.waitFor(() => tg.callsFor("sendMessage").length > before + 1, 5000, "opt-in confirmation + welcome menu");
    let row = await consentRow(world, key);
    assert(row?.granted === true && !row.withdrawn_at, `/start must grant consent, got ${JSON.stringify(row)}`);
    assert(await hasChannelConsent(TENANT_ID, key, CONSENT_CHANNEL_TELEGRAM) === true, "consent must be active after /start");

    // 2. STOP (plain text) → revocation honored on subsequent checks.
    before = tg.callsFor("sendMessage").length;
    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970241, chatId, fromId, "STOP"));
    assert(res.status === 200, "STOP must ack 200");
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 5000, "stop confirmation");
    row = await consentRow(world, key);
    assert(row?.granted === false && row?.withdrawn_at, `STOP must revoke + stamp withdrawn_at, got ${JSON.stringify(row)}`);
    assert(
      await hasChannelConsent(TENANT_ID, key, CONSENT_CHANNEL_TELEGRAM) === false,
      "revocation must be honored by subsequent consent checks",
    );
    const stopText = String(tg.callsFor("sendMessage").at(-1)!.body?.text ?? "");
    assert(/opted out/i.test(stopText), "stop confirmation copy");

    // 3. /stop command form on a fresh chat (no prior row) → explicit denial row.
    const chat2 = "880240";
    const key2 = `telegram:${chat2}`;
    before = tg.callsFor("sendMessage").length;
    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970242, chat2, 770240, "/stop"));
    assert(res.status === 200, "/stop must ack 200");
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 5000, "/stop confirmation");
    row = await consentRow(world, key2);
    assert(row?.granted === false && row?.withdrawn_at, "/stop with no prior row must persist an explicit revocation");

    // 4. /start again → re-opt-in (withdrawal cleared).
    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970243, chatId, fromId, "/start"));
    assert(res.status === 200, "re-start must ack 200");
    await world.waitFor(async () => (await consentRow(world, key))?.granted === true, 5000, "re-opt-in");
    row = await consentRow(world, key);
    assert(row?.granted === true && !row.withdrawn_at, "re-/start must clear the withdrawal");
  },
};
