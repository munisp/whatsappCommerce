/**
 * === W37 telegram (Coder B) ===
 * J237 — contact-share binding (chat_id ↔ phone), self-share only.
 *
 *  1. contact.user_id == from.id → telegram_identities row binds the chat to
 *     the E.164 phone (digits), linked_via = telegram_contact_share, and the
 *     user gets a confirmation.
 *  2. contact.user_id != from.id (sharing someone else's contact) → REJECTED:
 *     no identity row, an honest refusal reply. Phone linkage is never
 *     inferred.
 *  3. Re-share updates the binding (upsert on tenant+chat).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

function contactUpdate(updateId: number, chatId: string, fromId: number, contactUserId: number, phone: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: fromId, first_name: "Tg", username: `tguser${fromId}` },
      chat: { id: Number(chatId), type: "private" },
      date: 1788000000,
      contact: { phone_number: phone, first_name: "Shared", user_id: contactUserId },
    },
  };
}

async function identityRows(world: World, chatId: string): Promise<any[]> {
  const r = await world.pg.query(
    `SELECT chat_id, phone_e164, username, linked_via FROM telegram_identities WHERE tenant_id = $1 AND chat_id = $2`,
    [TENANT_ID, chatId],
  );
  return ((r as any).rows ?? r) as any[];
}

export const journey: Journey = {
  id: "J237",
  name: "telegram contact-share binding (self-share only, no inference)",
  feature: "W37 telegram channel identity",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);

    // 1. Self-share binds chat_id ↔ phone.
    const chatId = "880237";
    const fromId = 770237;
    const before = tg.callsFor("sendMessage").length;
    let res = await tgPost(world, TENANT_ID, TG_SECRET, contactUpdate(970237, chatId, fromId, fromId, "+234 801 111 2222"));
    assert(res.status === 200, `contact update must ack 200, got ${res.status}`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 5000, "binding confirmation");
    let rows = await identityRows(world, chatId);
    assert(rows.length === 1, "self-share must create exactly one identity row");
    assert(rows[0].phone_e164 === "2348011112222", `phone must normalize to E.164 digits, got ${rows[0].phone_e164}`);
    assert(rows[0].linked_via === "telegram_contact_share", "linked_via audit");
    assert(rows[0].username === `tguser${fromId}`, "username captured");

    // 2. Sharing SOMEONE ELSE's contact is rejected (no inference).
    const chat2 = "880238";
    const from2 = 770238;
    const before2 = tg.callsFor("sendMessage").length;
    res = await tgPost(world, TENANT_ID, TG_SECRET, contactUpdate(970238, chat2, from2, 999999, "+2348099999999"));
    assert(res.status === 200, `non-self contact update must still ack 200, got ${res.status}`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > before2, 5000, "refusal reply");
    const refusal = tg.callsFor("sendMessage").at(-1)!;
    assert(/only link a phone number you share about yourself/i.test(String(refusal.body?.text ?? "")), "must send an honest refusal");
    rows = await identityRows(world, chat2);
    assert(rows.length === 0, "non-self contact-share must NOT bind a phone");

    // 3. Re-share updates the same row (upsert on tenant+chat).
    res = await tgPost(world, TENANT_ID, TG_SECRET, contactUpdate(970239, chatId, fromId, fromId, "2348022223333"));
    assert(res.status === 200, "re-share must ack 200");
    await world.waitFor(async () => (await identityRows(world, chatId))[0]?.phone_e164 === "2348022223333", 5000, "re-bind");
    rows = await identityRows(world, chatId);
    assert(rows.length === 1 && rows[0].phone_e164 === "2348022223333", "re-share must update in place");
  },
};
