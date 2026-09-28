/**
 * === W53 RESIDUALS ===
 * J538 — menu system convergence bridge: publishing a legacy table-based
 * menu (routers/menu.ts) syncs its items INTO settings.waMenu.customItems
 * (the single runtime source of truth), so BOTH the WhatsApp interactive
 * menu and the Telegram menu keyboard immediately reflect the published
 * items. The tenant's prior waMenu config is restored afterwards.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, TG_SECRET } from "./j235-telegram-webhook-security";

const ITEM_TITLE = "J538 Published Special";
const ITEM_DESC = "Sizzling W53 bridge special";

export const journey: Journey = {
  id: "J538",
  name: "legacy menu publish syncs settings.waMenu → WA + TG render it",
  feature: "W53 residuals: menu convergence bridge",
  async run(world: World) {
    const { appRouter } = await import("../../server/routers");
    const { loadMenuConfig } = await import("../../server/services/waMenu");
    const caller = appRouter.createCaller({
      user: { id: "sim-j538", tenantId: TENANT_ID, role: "user" },
    } as any);
    const before = await world.tenantSettings();
    let menuId: string | null = null;

    try {
      // 1. Build + publish a legacy table menu via the portal surface.
      const created = await caller.menu.create({ name: "J538 Bridge Menu" });
      menuId = created.id;
      const section = await caller.menu.addItem({
        menuId,
        item: { type: "section", title: "W53 Specials", sortOrder: 0 },
      });
      await caller.menu.addItem({
        menuId,
        item: {
          type: "quick_reply",
          title: ITEM_TITLE,
          description: ITEM_DESC,
          payload: "J538_SPECIAL",
          parentId: (section as any)?.id ?? null,
          sortOrder: 1,
        } as any,
      });
      const published = await caller.menu.publish({ menuId });
      assert(published.success === true, "publish succeeds");
      assert((published as any).syncedToWaMenu >= 1, `publish reports the sync bridge count, got ${(published as any).syncedToWaMenu}`);

      // 2. settings.waMenu now carries the published item (engine truth).
      const cfg = loadMenuConfig({ settings: await world.tenantSettings() });
      const custom = cfg.customItems.find((c) => c.label === ITEM_TITLE);
      assert(custom, "published item present in settings.waMenu customItems");
      assert(custom!.response === ITEM_DESC, "custom item response mapped from the item description");
      // Pre-existing engine config preserved (defaults still render).
      assert(cfg.useCases.some((u) => u.id === "shop" && u.enabled), "use-case config preserved by the merge");

      // 2b. The portal effective-config read reflects the same truth.
      const eff = await caller.menu.effectiveConfig();
      assert(eff.customItems.some((c) => c.label === ITEM_TITLE), "effectiveConfig mirrors the published item");

      // 3. WhatsApp: "menu" renders the published item in the interactive payload.
      const waPhone = world.newPhone("j538wa");
      await world.grantConsent(waPhone);
      await world.text(waPhone, "menu");
      const iv = world.outbound.lastOfType("interactive", waPhone);
      assert(iv, "WA menu is an interactive payload");
      assert(
        JSON.stringify(iv.body?.interactive).includes(ITEM_TITLE),
        "WA interactive menu contains the published item",
      );

      // 4. Telegram: "menu" keyboard renders the SAME published item.
      await ensureTelegramConfig(world);
      const chatId = "880538";
      const { tg } = await import("../metaMock");
      const { recordConsent } = await import("../../server/services/consent");
      await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
      await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, granted: true });
      const tgBefore = tg.callsFor("sendMessage").length;
      const res = await tgPost(world, TENANT_ID, TG_SECRET, {
        update_id: 970538,
        message: { message_id: 1538, from: { id: 770538, first_name: "W53" }, chat: { id: Number(chatId), type: "private" }, date: 1788000538, text: "menu" },
      });
      assert(res.status === 200, `TG webhook ack 200 (got ${res.status})`);
      await world.waitFor(() => tg.callsFor("sendMessage").length > tgBefore, 10000, "TG menu keyboard");
      const sent = tg.callsFor("sendMessage").at(-1)!;
      assert(
        JSON.stringify(sent.body?.reply_markup ?? {}).includes(ITEM_TITLE),
        "TG menu keyboard contains the published item",
      );
    } finally {
      // Restore the tenant's prior engine config + drop the legacy menu rows.
      await world.patchTenantSettings({ waMenu: (before as any).waMenu ?? null });
      if (menuId) {
        await caller.menu.delete({ menuId }).catch(() => { /* best-effort cleanup */ });
      }
    }
  },
};
