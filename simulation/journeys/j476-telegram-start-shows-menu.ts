/**
 * J476 — /start (and every other way of granting Telegram consent) shows the welcome menu in the SAME turn as the
 * opt-in confirmation, matching WhatsApp: a fresh "YES" reply there returns "consentGranted\n\nmenu" together, never
 * a bare confirmation that leaves the buyer guessing what to type next. Telegram's /start used to send only the
 * confirmation text (server/services/telegramInbound.ts's TG_OPT_IN_REPLY) with no follow-up — found live on
 * 2026-09-25 when a business owner clicked Start and got no menu. Covers all three grant paths: /start, a first-
 * contact "YES" reply, and re-granting from a revoked ("STOP"'d) state.
 */
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

const MENU_MARKER = "How can we help";

export const journey: Journey = {
  id: "J476",
  name: "telegram consent grant (every path) shows the welcome menu in the same turn",
  feature: "Telegram/WhatsApp parity — post-consent menu",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);
    let uid = 4760001;

    const sendsTo = (chatId: string) => tg.callsFor("sendMessage").filter((c: any) => String(c.body?.chat_id) === chatId);
    const isInteractiveMenu = (c: any) =>
      typeof c?.body?.text === "string" && c.body.text.includes(MENU_MARKER) && Array.isArray(c?.body?.reply_markup?.inline_keyboard);

    // ── A. /start on a brand-new chat ────────────────────────────────────────
    const chatA = "476001";
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatA, 4760099, "/start"));
    await world.waitFor(() => sendsTo(chatA).length >= 2, 5000, "opt-in confirmation + welcome menu after /start");
    const aMsgs = sendsTo(chatA);
    assert(aMsgs.some((c: any) => /opted in/i.test(String(c.body?.text ?? ""))), "one send is the opt-in confirmation");
    assert(aMsgs.some(isInteractiveMenu), "one send is the interactive welcome menu (buttons, not just text)");

    // ── B. First-contact "YES" reply to the consent prompt ────────────────────
    const chatB = "476002";
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatB, 4760098, "hi"));
    await world.waitFor(() => sendsTo(chatB).length >= 1, 5000, "consent prompt");
    assertIncludes(String(sendsTo(chatB).at(-1)?.body?.text ?? ""), "NDPR", "first contact prompts consent");
    const beforeYes = sendsTo(chatB).length;
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatB, 4760098, "YES"));
    await world.waitFor(() => sendsTo(chatB).length >= beforeYes + 2, 5000, "opt-in confirmation + welcome menu after YES");
    const bNew = sendsTo(chatB).slice(beforeYes);
    assert(bNew.some((c: any) => /opted in|consent/i.test(String(c.body?.text ?? ""))), "one send is the grant confirmation");
    assert(bNew.some(isInteractiveMenu), "one send is the interactive welcome menu");

    // ── C. Re-granting from a revoked state (STOP, then YES) ──────────────────
    const chatC = "476003";
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatC, 4760097, "/start"));
    await world.waitFor(() => sendsTo(chatC).length >= 2, 5000, "initial /start settles");
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatC, 4760097, "STOP"));
    await world.waitFor(
      () => /opted out/i.test(String(sendsTo(chatC).at(-1)?.body?.text ?? "")),
      5000, "stop confirmation",
    );
    const beforeRegrant = sendsTo(chatC).length;
    await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatC, 4760097, "YES"));
    await world.waitFor(() => sendsTo(chatC).length >= beforeRegrant + 2, 5000, "opt-in confirmation + welcome menu after re-grant");
    const cNew = sendsTo(chatC).slice(beforeRegrant);
    assert(cNew.some((c: any) => /opted in/i.test(String(c.body?.text ?? ""))), "one send is the re-grant confirmation");
    assert(cNew.some(isInteractiveMenu), "one send is the interactive welcome menu, even after re-granting from revoked");
  },
};
