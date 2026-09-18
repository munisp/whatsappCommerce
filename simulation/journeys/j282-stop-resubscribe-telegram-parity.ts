/**
 * === W40 MSG-1 ===
 * J282 — Resubscribe via opt-in keyword + Telegram STOP parity.
 *
 * WhatsApp:
 *   1. A revoked identity replies "YES" → consent re-granted (withdrawnAt
 *      cleared) and the menu re-opens — the documented resubscribe path.
 *
 * Telegram (W37 parity verification):
 *   2. /start opt-in → plain-text "STOP" revokes → subsequent text gets NO
 *      reply (previously Telegram revoked but kept dispatching to NLP —
 *      parity gap closed in W40) → "YES" re-opts-in with a confirmation.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J282",
  name: "resubscribe via YES + telegram STOP parity (MSG-1)",
  feature: "explicit re-opt-in re-opens the conversation on both channels",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── 1. WhatsApp: STOP → silence → YES resubscribes ──────────────────
    const phone = world.newPhone("r");
    await world.text(phone, "hi");
    await world.text(phone, "YES");
    await world.text(phone, "STOP");
    const silentBefore = world.outbound.toPhone(phone).length;
    await world.text(phone, "menu");
    assert(world.outbound.toPhone(phone).length === silentBefore, "setup: silenced after STOP");

    await world.text(phone, "YES");
    const [row] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, phone))).limit(1);
    assert(row?.granted === true, `YES must re-grant consent, got ${row?.granted}`);
    assert(!row?.withdrawnAt, "re-opt-in clears the withdrawal stamp");
    const reopt = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reopt, "opted in", "resubscribe confirmation");
    // Conversation re-opened: the menu renders again on the next keyword.
    const menuBefore = world.outbound.toPhone(phone).length;
    await world.text(phone, "menu");
    assert(world.outbound.toPhone(phone).length > menuBefore, "bot replies again after resubscribe");

    // ── 2. Telegram parity: revoke → silence → YES re-opt-in ────────────
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    const chatId = "880281";
    const fromId = 770281;
    // W40 merger fix-forward: the tg mock is shared across the whole suite —
    // count only sendMessage calls addressed to THIS chat so trailing async
    // sends from earlier journeys (broadcasts etc.) cannot flake the silence
    // assertion.
    const sendsToChat = () =>
      tg.callsFor("sendMessage").filter((c: any) => String(c.body?.chat_id) === chatId);

    let res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(980281, chatId, fromId, "/start"));
    assert(res.status === 200, "start ack");
    await world.waitFor(() => sendsToChat().length > 0, 5000, "tg opt-in confirmation");

    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(980282, chatId, fromId, "STOP"));
    assert(res.status === 200, "STOP ack");
    await world.waitFor(
      () => sendsToChat().length >= 2, 5000, "tg stop confirmation");

    // Subsequent inbound: bot silent (parity with the WA interceptor).
    const tgBefore = sendsToChat().length;
    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(980283, chatId, fromId, "hello, what do you sell?"));
    assert(res.status === 200, "text ack");
    await world.settle(600);
    assert(sendsToChat().length === tgBefore, "telegram bot silent after STOP (W40 parity)");

    // YES re-opts in with a confirmation.
    res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(980284, chatId, fromId, "YES"));
    assert(res.status === 200, "YES ack");
    await world.waitFor(() => sendsToChat().length > tgBefore, 5000, "tg re-opt-in confirmation");
    const tgLast = String(sendsToChat().at(-1)!.body?.text ?? "");
    assertIncludes(tgLast, "opted in", "telegram resubscribe confirmation");
  },
};
