// === W37 telegram (Coder A) ===
/**
 * J231 — telegramSender builds correct Bot API payloads.
 *
 *   1. TELEGRAM_ENABLED default false → send is simulated, NO Bot API call.
 *   2. Enabled + tenant bot token (v1:-encrypted in settings.telegram) →
 *      sendTelegramText POSTs sendMessage with chat_id/parse_mode HTML/
 *      disable_web_page_preview; long text chunks at TG_TEXT_LIMIT.
 *   3. sendTelegramKeyboard → inline_keyboard whose callback_data carries the
 *      EXISTING id grammar (menu_<n>, order_*, catalog_ai:*) verbatim + URL
 *      button support.
 *   4. sendTelegramList → chunked keyboard page + menu_more_<offset> "More".
 *   5. sendTelegramMedia (photo by URL), location + contact request keyboards.
 * All Bot API calls are intercepted by the sim fetch mock catch-all
 * (meta.hostStatus scripts api.telegram.org → 200).
 */
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { meta, outbound } from "../metaMock";

const CHAT = "770001";
const TOKEN = "123456:SIM_BOT_TOKEN";

function tgCalls() {
  return outbound.all().filter((c: any) => String(c.url).includes("api.telegram.org"));
}

async function configureTenantBot(world: World) {
  const { encryptSecret } = await import("../../server/services/crypto/secrets");
  const tg = JSON.stringify({ telegram: { botToken: encryptSecret(TOKEN), enabled: true } });
  await world.db.execute(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${tg}'::jsonb WHERE id = '${TENANT_ID}'`,
  );
}

export const journey: Journey = {
  id: "J231",
  name: "telegramSender Bot API payloads: text/keyboard/list/media/location/contact",
  feature: "W37 telegram outbound: Bot API payload parity with waSender",
  async run(world: World) {
    const tg = await import("../../server/services/telegramSender");

    // ── 1. Disabled by default → simulation, no HTTP call ──────────────
    delete process.env.TELEGRAM_ENABLED;
  const before = tgCalls().length;
    const disabled = await tg.sendTelegramText(TENANT_ID, CHAT, "hello telegram");
    assert(disabled.simulated === true && disabled.sent === false, "TELEGRAM_ENABLED unset must simulate");
    assert(tgCalls().length === before, "no Bot API HTTP call while disabled");

    // ── 2. Enabled + encrypted tenant token → real sendMessage payload ──
    process.env.TELEGRAM_ENABLED = "true";
    meta.hostStatus.set("api.telegram.org", 200);
    await configureTenantBot(world);

    const text = await tg.sendTelegramText(TENANT_ID, CHAT, "Order *confirmed* — track below");
    assert(text.sent === true && text.simulated === false, `text send must be live (got ${JSON.stringify(text)})`);
    const sendMsg = tgCalls().filter((c: any) => String(c.url).includes(`/bot${TOKEN}/sendMessage`));
    assert(sendMsg.length === 1, `exactly 1 sendMessage call (got ${sendMsg.length})`);
    const body = sendMsg[0].body as any;
    assert(String(body.chat_id) === CHAT, "chat_id passed through");
    assert(body.text.includes("Order *confirmed*"), "text body intact");
    assert(body.parse_mode === "HTML", "parseMode HTML default");
    assert(body.disable_web_page_preview === true, "preview disabled default");

    // Chunking at TG_TEXT_LIMIT.
    const long = await tg.sendTelegramText(TENANT_ID, CHAT, "x".repeat(4100) + "\n" + "y".repeat(200));
    assert(long.chunks === 2, `4100+ chars must chunk (got ${long.chunks})`);

    // ── 3. Keyboard: existing id grammar verbatim + URL button ─────────
    await tg.sendTelegramKeyboard(TENANT_ID, CHAT, "Pick an action", [
      { id: "menu_2", title: "Orders" },
      { id: "order_track:ord_1", title: "Track" },
      { id: "catalog_ai:approve", title: "Approve" },
      { id: "pay_now", title: "Pay", url: "https://pay.sim.local/tx_1" },
    ]);
    const kbCall = tgCalls().filter((c: any) => JSON.stringify(c.body ?? {}).includes("inline_keyboard")).pop();
    assert(kbCall, "keyboard send recorded");
    const kb = (kbCall.body as any).reply_markup.inline_keyboard as Array<Array<any>>;
    const flat = kb.flat();
    assert(flat[0].callback_data === "menu_2", "menu_<n> id preserved as callback_data");
    assert(flat.some((b) => b.callback_data === "order_track:ord_1"), "order_* id preserved");
    assert(flat.some((b) => b.callback_data === "catalog_ai:approve"), "catalog_ai:* id preserved");
    assert(flat.some((b) => b.url === "https://pay.sim.local/tx_1"), "URL button rendered with url (not callback_data)");
    assert(kb.every((row) => row.length <= 2), "default 2 buttons per row");

    // ── 4. List chunking + More pagination ─────────────────────────────
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `menu_${i + 1}`, title: `Item ${i + 1}` }));
    await tg.sendTelegramList(TENANT_ID, CHAT, "Catalog", rows);
    const listCall = tgCalls().filter((c: any) => JSON.stringify(c.body ?? {}).includes("Catalog")).pop();
    const listKb = (listCall.body as any).reply_markup.inline_keyboard as Array<Array<any>>;
    const listFlat = listKb.flat();
    assert(listFlat.length === 9, `page of 8 + More button (got ${listFlat.length})`);
    assert(listFlat[0].text.startsWith("1. "), "rows numbered for numeric-reply equivalence");
    const more = listFlat[listFlat.length - 1];
    assert(more.callback_data === "menu_more_8", `More pagination id (got ${more.callback_data})`);
    // Page 2 renders the next slice.
    await tg.sendTelegramList(TENANT_ID, CHAT, "Catalog", rows, { page: 1 });
    const page2 = tgCalls().filter((c: any) => JSON.stringify(c.body ?? {}).includes("continued")).pop();
    assert(page2, "page 2 marked as continued");
    const page2Flat = ((page2.body as any).reply_markup.inline_keyboard as any[]).flat();
    assert(page2Flat[0].callback_data === "menu_9", "page 2 starts at row 9");

    // ── 5. Media + location/contact request keyboards ──────────────────
    await tg.sendTelegramMedia(TENANT_ID, CHAT, { type: "photo", url: "https://cdn.sim.local/ankara.jpg", caption: "Ankara" });
    const photo = tgCalls().filter((c: any) => String(c.url).includes("/sendPhoto")).pop();
    assert(photo, "sendPhoto called");
    assert((photo.body as any).photo === "https://cdn.sim.local/ankara.jpg", "photo URL passed");
    assert((photo.body as any).caption === "Ankara", "caption passed");

    await tg.sendTelegramLocationRequest(TENANT_ID, CHAT, "Share delivery location");
    const loc = tgCalls().filter((c: any) => JSON.stringify(c.body ?? {}).includes("request_location")).pop();
    assert(loc, "location request sent");
    assert((loc.body as any).reply_markup.keyboard[0][0].request_location === true, "request_location reply keyboard");

    await tg.sendTelegramContactRequest(TENANT_ID, CHAT, "Share your phone to link");
    const contact = tgCalls().filter((c: any) => JSON.stringify(c.body ?? {}).includes("request_contact")).pop();
    assert(contact, "contact request sent");
    assert((contact.body as any).reply_markup.keyboard[0][0].request_contact === true, "request_contact reply keyboard");

    // answerCallbackQuery + editMessageReplyMarkup + sendChatAction plumbing.
    const ack = await tg.answerCallbackQuery(TENANT_ID, "cbq_1", { text: "Got it" });
    assert(ack === true, "callback ack ok against 200 mock");
    assert(tgCalls().some((c: any) => String(c.url).includes("/answerCallbackQuery")), "ack hit Bot API");
    const cleared = await tg.editMessageReplyMarkup(TENANT_ID, CHAT, 555);
    assert(cleared === true, "clear markup ok");
    const clearCall = tgCalls().filter((c: any) => String(c.url).includes("/editMessageReplyMarkup")).pop();
    assert(JSON.stringify((clearCall.body as any).reply_markup) === JSON.stringify({ inline_keyboard: [] }), "keyboard cleared after tap");
    assert((await tg.sendChatAction(TENANT_ID, CHAT)) === true, "typing action ok");

    // Restore env for later journeys (Telegram default-disabled again).
    delete process.env.TELEGRAM_ENABLED;
    meta.hostStatus.delete("api.telegram.org");
  },
};
