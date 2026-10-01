// === W51 PROMOS ===
/**
 * J528 — 30-minute per-session dedupe: consecutive inquiry turns in one
 * session produce at most ONE promo card; a different session (phone) still
 * gets its own card.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J528",
  name: "promo spotlight deduped to one card per session per 30 min",
  feature: "W51 promos: anti-spam dedupe",
  async run(world: World) {
    const before = await world.tenantSettings();
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({ user: null } as any);
    try {
      await world.patchTenantSettings({ promos: [{ code: "ONCE20", type: "percent", value: 20 }] });
      world.llm.when(/sell/i, {
        reply: "Catalog incoming.",
        intent: "browse", nextState: "browse",
        extractedItems: [], extractedProduct: null,
        extractedQuantity: null, extractedAddress: null, confidence: 0.9,
      });
      const phone = world.newPhone("8");
      const r1 = await caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: phone, message: "what do you sell?" });
      assert((r1 as any).promoCard != null, "first inquiry shows the card");
      const r2 = await caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: phone, message: "what else do you sell?" });
      assert((r2 as any).promoCard == null, "second inquiry within 30 min is deduped");
      const r3 = await caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: world.newPhone("8"), message: "what do you sell?" });
      assert((r3 as any).promoCard != null, "a different session still gets its own card");
    } finally {
      world.llm.reset();
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
    }
  },
};
