// === W51 PROMOS ===
/**
 * J523 — no promo → no card; showActive toggle off → no card.
 *
 *   1. Tenant without any promos: a browse inquiry annotates no promoCard.
 *   2. settings.promos.showActive = false with a valid promo configured:
 *      still no card and no USSD/SMS one-liner (the master switch wins).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

async function nlpCaller() {
  const { appRouter } = await import("../../server/routers");
  return appRouter.createCaller({ user: null } as any);
}

export const journey: Journey = {
  id: "J523",
  name: "no promos / showActive=false → no promo card annotation",
  feature: "W51 promos: spotlight gating",
  async run(world: World) {
    const before = await world.tenantSettings();
    const caller = await nlpCaller();
    try {
      world.llm.when(/what do you sell/i, {
        reply: "Here is the catalog.",
        intent: "browse", nextState: "browse",
        extractedItems: [], extractedProduct: null,
        extractedQuantity: null, extractedAddress: null, confidence: 0.9,
      });

      // 1. No promos at all → nothing annotated (both channels' shapes).
      await world.patchTenantSettings({ promos: [] });
      const phone1 = world.newPhone("3");
      const r1 = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone1, message: "what do you sell?",
      });
      assert(r1 && (r1 as any).promoCard == null, "no promoCard without promos");
      assert(!String((r1 as any).reply).includes("DEAL:"), "no promo one-liner without promos");

      // 2. Valid promo but showActive=false (array-form tenants carry the
      //    toggles under settings.promoDisplay) → master switch suppresses
      //    the card AND the text-only (SMS) one-liner.
      await world.patchTenantSettings({
        promos: [{ code: "HIDDEN10", type: "percent", value: 10 }],
        promoDisplay: { showActive: false },
      });
      const phone2 = world.newPhone("3");
      const r2 = await caller.nlp.processMessage({
        tenantId: TENANT_ID, waPhoneNumber: phone2, message: "what do you sell?", channel: "sms",
      });
      assert(r2 && (r2 as any).promoCard == null, "showActive=false suppresses the card");
      assert(!String((r2 as any).reply).includes("HIDDEN10"), "showActive=false suppresses the one-liner");
    } finally {
      world.llm.reset();
      await world.patchTenantSettings({
        promos: (before as any)?.promos ?? [],
        promoDisplay: (before as any)?.promoDisplay,
      });
    }
  },
};
