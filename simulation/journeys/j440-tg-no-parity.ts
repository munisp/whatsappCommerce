// === W47 buyer (Coder B) ===
/**
 * J440 — ONB-B-4 + ONB-B-9: Telegram first-contact "NO" follows the WA J1
 * contract (granted=false WITHOUT withdrawnAt → limited service, can still
 * chat — not a silent drop), and the re-grant rate limit produces an
 * explanatory reply instead of silence.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J440",
  name: "ONB-B-4/B-9 telegram first-contact NO keeps limited service; re-grant limit explained",
  feature: "W47 buyer TG consent parity",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    const lastTg = (chatId: string) =>
      tg.callsFor("sendMessage").filter((c) => String(c.body?.chat_id) === String(chatId)).pop();

    // 1. First-contact NO → denial row WITHOUT withdrawnAt + limited-service copy.
    const chatId = "77440001";
    let uid = 88440001;
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, 44001, "hello"));
    await world.settle();
    assertIncludes(String(lastTg(chatId)?.body?.text ?? ""), "NDPR", "first contact prompts consent");
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, 44001, "NO"));
    await world.settle();
    const denial = String(lastTg(chatId)?.body?.text ?? "");
    assertIncludes(denial, "opted out", "denial acknowledged");
    assertIncludes(denial, "can still message us anytime", "limited-service copy (WA J1 parity)");
    const [row] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, `telegram:${chatId}`)));
    assert(row && row.granted === false, "denial row recorded");
    assert(!row.withdrawnAt, "first-contact NO does NOT set withdrawnAt (not a revocation)");

    // 2. The denier can STILL CHAT: a follow-up question is not silent-dropped.
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, 44001, "What are your opening hours?"));
    await world.settle();
    const followUp = String(lastTg(chatId)?.body?.text ?? "");
    assert(followUp.length > 0 && !followUp.includes("opted out"), `denier still gets service (got '${followUp.slice(0, 60)}')`);

    // 3. ONB-B-9: re-grant rate limit throws → explanatory reply (not silence).
    const chat2 = "77440002";
    const key2 = `telegram:${chat2}`;
    await world.db.insert(schema.consents).values({
      tenantId: TENANT_ID, phone: key2, channel: "telegram",
      granted: false, withdrawnAt: new Date(), regrantCount: 3, lastRegrantAt: new Date(),
      source: "telegram_stop",
    });
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: uid++,
      message: {
        message_id: 991, from: { id: 44002, first_name: "Tg" }, chat: { id: Number(chat2), type: "private" },
        date: 1788000000, text: "/start",
      },
    });
    await world.settle();
    const limited = String(lastTg(chat2)?.body?.text ?? "");
    assertIncludes(limited, "too many re-grants", "rate limit explained to the user");
    const [row2] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, key2)));
    assert(row2.granted === false && row2.withdrawnAt, "withdrawal stands under rate limiting");
  },
};
