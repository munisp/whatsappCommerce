// === W51 PROMOS ===
/**
 * J527 — pcm (Nigerian Pidgin) promo rendering: the MESSAGE_CATALOG pcm
 * pack drives the promo one-liner/body, and an SMS-channel inquiry in
 * pidgin gets the localized promo line prepended to the reply.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J527",
  name: "pcm locale promo one-liner + SMS channel text parity",
  feature: "W51 promos: i18n pcm + SMS",
  async run(world: World) {
    const before = await world.tenantSettings();
    const { renderPromoLine, renderPromoBody } = await import("../../server/services/promoSpotlight");
    const { t27 } = await import("../../server/services/i18n");
    try {
      // 1. Direct pcm rendering from the catalog.
      const promo = { kind: "promo" as const, title: "Promo PCM10", discountText: "10% off", code: "PCM10" };
      const line = renderPromoLine("pcm", promo);
      assert(line.includes("DEAL:") && line.includes("PCM10"), `pcm one-liner renders (got ${line})`);
      assert(t27("pcm", "popularBadge").includes("order pass"), "pcm badge copy from the catalog");
      assert(renderPromoBody("pcm", promo).includes("PCM10"), "pcm card body renders");

      // 2. SMS-channel inquiry in pidgin → localized promo line in the reply
      //    (text-only channels never annotate promoCard).
      await world.patchTenantSettings({ promos: [{ code: "PCM10", type: "percent", value: 10 }] });
      world.llm.when(/sell/i, {
        reply: "We get plenty things.",
        intent: "browse", nextState: "browse",
        extractedItems: [], extractedProduct: null,
        extractedQuantity: null, extractedAddress: null, confidence: 0.9,
      });
      const { appRouter } = await import("../../server/routers");
      const caller = appRouter.createCaller({ user: null } as any);
      const r = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: world.newPhone("7"),
        message: "abeg wetin you dey sell", channel: "sms",
      });
      assert(String(r.reply).startsWith("DEAL:"), `SMS reply leads with the promo line (got ${String(r.reply).slice(0, 120)})`);
      assert(String(r.reply).includes("PCM10"), "promo code present");
      assert((r as any).promoCard == null, "no rich card on the SMS channel");
    } finally {
      world.llm.reset();
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
    }
  },
};
