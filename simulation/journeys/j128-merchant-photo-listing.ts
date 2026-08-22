/**
 * J128 — W27 catalog-ai: merchant product photo → vision-drafted listing →
 * button confirm → product live. Vision LLM is scripted via world.llm.when
 * (matches the analysis prompt); no live API calls. The merchant-stated price
 * is absent, so the deterministic category-median price suggestion fills in.
 */
import { eq } from "drizzle-orm";
import { scriptMedia } from "../metaMock";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J128",
  name: "merchant photo → listing",
  feature: "photo → vision → draft → button publish (median price suggestion)",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const merchant = world.newPhone("j128");
    await world.grantConsent(merchant);
    await world.db.insert(schema.users).values({
      openId: "sim-merchant-j128",
      name: "Sim Merchant 128",
      phone: merchant,
      tenantId: TENANT_ID,
      lastSignedIn: new Date(),
    }).onConflictDoNothing();

    // Comparable in-tenant products (unique category isolates the stats) → median 25000 (₦250.00).
    for (const [id, price] of [["p-j128-a", "200.00"], ["p-j128-b", "250.00"], ["p-j128-c", "300.00"]] as const) {
      await world.db.insert(schema.products).values({
        id, tenantId: TENANT_ID, sku: `SIM-J128-${id}`, name: `Snack ${id}`,
        category: "j128snacks", price, currency: "NGN", status: "active", stockQuantity: 5,
      }).onConflictDoNothing();
    }

    world.llm.when("Analyse this product photo", {
      title: "Plantain Chips 100g",
      description: "Crispy salted plantain chips, 100g pack.",
      category: "j128snacks",
      priceCents: null,
      confidence: 88,
    });

    scriptMedia("m-j128-photo", "SIMIMG plantain chips", "image/jpeg");
    await world.image(merchant, "m-j128-photo");

    let draft: any = null;
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.catalogAiDrafts)
        .where(eq(schema.catalogAiDrafts.merchantPhone, merchant)).limit(5);
      draft = rows.find((r: any) => r.status === "pending_confirm") ?? null;
      return !!draft;
    }, 15000, "photo draft created");
    assert(draft.source === "photo", "draft source is photo");
    assert(draft.name === "Plantain Chips 100g", `vision title (got ${draft.name})`);
    assert(draft.category === "j128snacks", `vision category (got ${draft.category})`);
    assert(draft.suggestedPriceCents === 25000, `category median suggestion ₦250 (got ${draft.suggestedPriceCents})`);
    assert(draft.priceBandLowCents === 20000 && draft.priceBandHighCents === 30000,
      `price band 200–300 (got ${draft.priceBandLowCents}-${draft.priceBandHighCents})`);

    const card = world.outbound.lastOfType("interactive", merchant);
    assert(!!card, "interactive draft card sent");
    assertIncludes(bodyText(card!), "NGN 250.00", "card shows suggested median price");

    await world.buttonReply(merchant, `catalog_ai:publish:${draft.id}`, "✅ Publish");
    await world.waitFor(async () => {
      const [p] = await world.db.select().from(schema.products)
        .where(eq(schema.products.id, `ai-${draft.id.slice(0, 8)}`)).limit(1).catch(() => []);
      return !!p;
    }, 15000, "product published from photo draft");
    const [product] = await world.db.select().from(schema.products)
      .where(eq(schema.products.id, `ai-${draft.id.slice(0, 8)}`)).limit(1);
    assert(product.price === "250.00", `suggested price published (got ${product.price})`);
    assertIncludes(bodyText(world.outbound.lastOfType("text", merchant)), "live in your catalog", "publish confirmation");
  },
};
