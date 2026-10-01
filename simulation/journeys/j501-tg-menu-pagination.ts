/**
 * === W50 CHANNELS (Coder A) ===
 * J501 — TG menu pagination: a tenant menu with more entries than one
 * keyboard page renders a menu_more_<offset> "More" button; tapping it
 * re-renders the menu at the next page (same menu engine, next page).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J501",
  name: "telegram menu_more_<offset> paginates the tenant menu",
  feature: "W50 TG menu parity: menu_more_ pagination",
  async run(world: World) {
    const { tg } = await import("../metaMock");
    const { eq } = await import("drizzle-orm");
    const schema = await import("../../drizzle/schema");
    await ensureTelegramConfig(world);

    // Give the tenant a menu longer than one TG page (TG_LIST_PAGE_SIZE=8).
    const [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID));
    const settings = { ...(row.settings as any) };
    settings.waMenu = {
      greeting: "Big menu — pick one:",
      useCases: settings.waMenu?.useCases, // defaults when absent
      customItems: Array.from({ length: 8 }, (_, i) => ({
        key: `extra${i + 1}`, label: `Extra Service ${i + 1}`, response: `Extra ${i + 1} reply`,
      })),
    };
    await world.db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, TENANT_ID));

    const chatId = "880501";
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    // Page 0: 8 rows + a "More" button with menu_more_8.
    let before = tg.callsFor("sendMessage").length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970501,
      message: { message_id: 1501, from: { id: 770501, first_name: "Pg" }, chat: { id: Number(chatId), type: "private" }, date: 1788000501, text: "/menu" },
    });
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "menu page 0");
    const page0 = tg.callsFor("sendMessage").at(-1)!;
    const kb0 = page0.body?.reply_markup?.inline_keyboard ?? [];
    const moreBtn = kb0.flat().find((b: any) => typeof b?.callback_data === "string" && b.callback_data.startsWith("menu_more_"));
    assert(moreBtn, "page 0 carries a menu_more_<offset> More button");
    assert(moreBtn.callback_data === "menu_more_8", `offset = 8 (got ${moreBtn.callback_data})`);

    // Tap "More" → page 1 re-render numbered from 9.
    before = tg.callsFor("sendMessage").length;
    await tgPost(world, TENANT_ID, TG_SECRET, {
      update_id: 970502,
      callback_query: {
        id: "cbq-970502",
        from: { id: 770501, first_name: "Pg" },
        message: { message_id: 1502, chat: { id: Number(chatId), type: "private" }, date: 1788000502 },
        data: "menu_more_8",
      },
    });
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 8000, "menu page 1");
    const page1 = tg.callsFor("sendMessage").at(-1)!;
    const kb1 = (page1.body?.reply_markup?.inline_keyboard ?? []).flat();
    assert(kb1.length >= 1, "page 1 renders remaining entries");
    assert(String(kb1[0]?.text ?? "").startsWith("9."), `page 1 numbering continues from 9 (got ${kb1[0]?.text})`);
    assert(String(page1.body?.text ?? "").includes("continued"), "page 1 header marks continuation");
  },
};
