// === W49 RICHMEDIA ===
/**
 * J492 — RICH-4: WA product_list messages on top of the metaCatalog sync.
 *
 *   1. sendWhatsAppProductList emits interactive.type="product_list" with
 *      catalog_id + product_retailer_ids (metaMock capture).
 *   2. sendWhatsAppBrowseProducts uses the tenant's metaCatalog config and
 *      returns true; with no catalog configured it returns false (text menu
 *      fallback preserved).
 *   3. Builder caps: empty section / >10 items per section throw honestly.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J492",
  name: "WA product_list catalog message wired into browse",
  feature: "RICH-4",
  async run(world: World) {
    const { buildProductListPayload, sendWhatsAppProductList } = await import("../../server/services/waSender");
    const { sendWhatsAppBrowseProducts } = await import("../../server/services/richMedia");
    const { encryptSecret } = await import("../../server/services/crypto/secrets");
    const phone = "+2348017000492";

    // Builder caps.
    let threw = false;
    try { buildProductListPayload({ catalogId: "c1", bodyText: "b", sections: [] }); } catch { threw = true; }
    assert(threw, "product_list requires ≥1 section");
    threw = false;
    try {
      buildProductListPayload({ catalogId: "c1", bodyText: "b", sections: [{ productRetailerIds: Array.from({ length: 11 }, (_, i) => `p${i}`) }] });
    } catch { threw = true; }
    assert(threw, "product_list enforces ≤10 items per section");

    // Catalog explicitly disabled → honest false (text fallback).
    await world.patchTenantSettings({ metaCatalog: { enabled: false } });
    const before = await sendWhatsAppBrowseProducts(TENANT_ID, phone, [{ id: "p1", name: "A", priceText: "₦1" }]);
    assert(before === false, "metaCatalog disabled → fallback, no throw");

    // Configure a catalog and browse.
    await world.patchTenantSettings({ metaCatalog: { enabled: true, catalogId: "CAT-492", accessToken: encryptSecret("tok-492") } });
    const sent = await sendWhatsAppBrowseProducts(TENANT_ID, phone, [
      { id: "prod-492a", name: "Ankara", priceText: "₦4,500" },
      { id: "prod-492b", name: "Gele", priceText: "₦2,000" },
    ]);
    assert(sent === true, "browse sent as product_list");
    const wa = world.outbound.lastOfType("interactive", phone.replace("+", ""));
    const ia = (wa!.body as any).interactive;
    assert(ia.type === "product_list", `interactive type product_list (got ${ia.type})`);
    assert(ia.action.catalog_id === "CAT-492", "catalog id carried");
    const ids = ia.action.sections[0].product_items.map((x: any) => x.product_retailer_id);
    assert(ids.includes("prod-492a") && ids.includes("prod-492b"), "retailer ids carried");

    // Direct sender path also works.
    await sendWhatsAppProductList(TENANT_ID, phone, {
      catalogId: "CAT-492",
      bodyText: "More",
      sections: [{ productRetailerIds: ["prod-492a"] }],
    });
    // cleanup
    await world.patchTenantSettings({ metaCatalog: { enabled: false } });
  },
};
