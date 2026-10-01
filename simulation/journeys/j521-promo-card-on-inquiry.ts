// === W51 PROMOS ===
/**
 * J521 — promo spotlight card on a WhatsApp inquiry turn.
 *
 *   1. Tenant with an active promo (FLASH20, 20% off): a search inquiry
 *      (LLM-scripted search intent) delivers the reply text, the product
 *      card, and a promo spotlight interactive whose body carries the
 *      discount + code, with [Shop now][View deal][Popular items] buttons.
 *   2. Ordering: the promo card comes AFTER the product card; no order
 *      action card exists on inquiry turns so last-interactive pins are
 *      untouched.
 *   3. Tenant settings restored afterwards (no cross-journey leakage).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J521",
  name: "promo spotlight card on WA inquiry (image-header interactive)",
  feature: "W51 promos: WA promo card on browse/search",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    const phone = world.newPhone("1");
    try {
      await world.db.insert(schema.products).values({
        id: "p-j521", tenantId: TENANT_ID, sku: "SIM-J521", name: "J521 Ankara",
        price: "45.00", currency: "NGN", status: "active", stockQuantity: 5,
        imageUrl: "https://cdn.j521.example.com/ankara.jpg",
      }).onConflictDoNothing();
      await world.patchTenantSettings({
        promos: [{ code: "FLASH20", type: "percent", value: 20 }],
      });
      await world.grantConsent(phone);
      world.llm.when(/ankara/i, {
        reply: "Yes — J521 Ankara is in stock at ₦45.00.",
        intent: "search", nextState: "product_detail",
        extractedItems: [], extractedProduct: "J521 Ankara",
        extractedQuantity: null, extractedAddress: null, confidence: 0.9,
      });

      await world.text(phone, "do you have ankara?");
      const cards = world.outbound.ofType("interactive", phone)
        .map((c) => (c.body as any).interactive);
      const promoIx = cards.findIndex((i) =>
        JSON.stringify(i?.action?.buttons ?? {}).includes("promo_deal:FLASH20"));
      assert(promoIx >= 0, `promo spotlight interactive sent (got ${JSON.stringify(cards.map((c) => c?.body?.text))})`);
      const promo = cards[promoIx];
      assert(String(promo.body.text).includes("20% off"), `body carries the discount (got ${promo.body.text})`);
      assert(String(promo.body.text).includes("FLASH20"), "body carries the code");
      const ids = promo.action.buttons.map((b: any) => b.reply.id);
      // === W52 SHARE === the sim tenant HAS a public WA phone, so the card
      // is shareable: within the WA 3-button cap the buttons are
      // [Shop now][View deal][📤 Share] and Popular-items yields (the
      // "popular" keyword path is covered by J526/J528).
      assert(ids.includes("promo_shop") && ids.includes("promo_share:FLASH20"), `promo buttons present (got ${ids})`);
      assert(ids.length <= 3, `within the WA 3-button cap (got ${ids})`);
      const productIx = cards.findIndex((i) =>
        JSON.stringify(i?.action?.buttons ?? {}).includes("cart_add:p-j521"));
      assert(productIx >= 0, "product card also sent");
      assert(promoIx > productIx, "promo card appended AFTER the product card");
    } finally {
      world.llm.reset();
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
      await world.db.delete(schema.products).where(eq(schema.products.id, "p-j521")).catch(() => {});
    }
  },
};
