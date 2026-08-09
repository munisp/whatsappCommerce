/**
 * J29 — Meta catalog: product create/update fan out to /{catalogId}/items
 * upserts; archiving deletes the item. Asserted against the mock's item
 * store, not just "no error".
 */
import { CATALOG_ID, TENANT_ID, assert, assertIncludes, type World } from "../world";
import { catalogItems } from "../metaMock";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J29",
  name: "Meta catalog sync",
  feature: "/items upsert + delete",
  async run(world) {
    const caller = await adminCaller();

    // ── create → upsert ──────────────────────────────────────────────────
    const created = await caller.product.create({
      tenantId: TENANT_ID,
      name: "Sim Catalog Sneakers",
      sku: "SIM-CAT-1",
      price: "12500.00",
      currency: "NGN",
      stockQuantity: 4,
      description: "Catalog sync test product",
    });
    assert(created?.id, "product created");

    await world.waitFor(() => catalogItems(CATALOG_ID).has(created.id), 10000, "catalog upsert observed");
    const item = catalogItems(CATALOG_ID).get(created.id);
    assertIncludes(JSON.stringify(item), "Sim Catalog Sneakers", "catalog item carries the product name");
    const itemsCalls = world.outbound.all().filter((c) => c.url.includes(`/${CATALOG_ID}/items`) && c.method === "POST");
    assert(itemsCalls.length >= 1, "POST /{catalogId}/items observed on the mock");
    assertIncludes(JSON.stringify(itemsCalls[0].body), '"method":"UPDATE"', "create fan-out is an UPDATE request");

    // ── update → upsert with the new price ───────────────────────────────
    await caller.product.update({ id: created.id, tenantId: TENANT_ID, price: "11000.00" });
    await world.waitFor(() => JSON.stringify(catalogItems(CATALOG_ID).get(created.id) ?? {}).includes("11000"), 10000, "catalog price updated");

    // ── archive → delete ─────────────────────────────────────────────────
    await caller.product.update({ id: created.id, tenantId: TENANT_ID, status: "archived" });
    await world.waitFor(() => !catalogItems(CATALOG_ID).has(created.id), 10000, "catalog item deleted on archive");
    const deleteCalls = world.outbound.all().filter((c) =>
      c.url.includes(`/${CATALOG_ID}/items`) && JSON.stringify(c.body).includes('"method":"DELETE"'),
    );
    assert(deleteCalls.length >= 1, "DELETE request observed for the archive");
    assertIncludes(JSON.stringify(deleteCalls[deleteCalls.length - 1].body), created.id, "delete targets the product retailer id");
  },
};
