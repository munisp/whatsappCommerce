// === W51 PROMOS ===
/**
 * J529 — promo create/update/delete mirrors to the tenant-linked Medusa
 * storefront (admin API), idempotent via the persisted medusaPromotionId.
 *
 *   1. create → POST /admin/promotions with the Medusa v2 payload
 *      (percentage application_method); the returned id is stored on the
 *      promo (medusaPromotionId).
 *   2. update → POST /admin/promotions/{id} (no duplicate create).
 *   3. delete → DELETE /admin/promotions/{id}.
 *   4. fixed promos convert to INTEGER CENTS in the payload.
 */
import { and, eq } from "drizzle-orm";
import { erp } from "../metaMock";
import { assert, TENANT_ID, type World } from "../world";
import { adminCaller } from "./helpers";
import type { Journey } from "../runner";

const HOST = "medusa-j529.example.com";

export const journey: Journey = {
  id: "J529",
  name: "promo CRUD mirrors to linked Medusa promotions API (idempotent)",
  feature: "W51 promos: Medusa promo sync",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const before = await world.tenantSettings();
    try {
      await world.db.insert(schema.tenantIntegrations).values({
        tenantId: TENANT_ID, integrationType: "medusa", status: "active",
        baseUrl: `http://${HOST}`, apiKey: "j529-admin-token",
      }).onConflictDoNothing();
      erp.script(HOST, (body) => {
        if (body?.code === "MEDFIX") return { json: { promotion: { id: "prom_j529_fix" } } };
        return { json: { promotion: { id: "prom_j529" } } };
      });
      const caller = await adminCaller();

      // 1. Create → POST /admin/promotions, id persisted.
      const created = await caller.promos.create({
        tenantId: TENANT_ID,
        promo: { code: "MED20", type: "percent", value: 20 },
      });
      assert(created.ok, "promo created");
      assert((created.promo as any).medusaPromotionId === "prom_j529",
        `medusaPromotionId persisted (got ${JSON.stringify(created.promo)})`);
      const creates = erp.calls.filter((c) => c.url.includes("/admin/promotions") && c.method === "POST");
      assert(creates.length >= 1, "promotion POST captured");
      assert(creates[0].body?.code === "MED20", "payload carries the code");
      assert(creates[0].body?.application_method?.type === "percentage", "percent → percentage");
      assert(creates[0].body?.application_method?.value === 20, "integer percent value");

      // 2. Update → POST to the SAME remote id (no second create).
      await caller.promos.update({ tenantId: TENANT_ID, code: "MED20", patch: { value: 25 } });
      const updates = erp.calls.filter((c) => c.url.endsWith("/admin/promotions/prom_j529") && c.method === "POST");
      assert(updates.length === 1, `update hits the persisted id (got ${updates.length})`);
      assert(updates[0].body?.application_method?.value === 25, "updated value pushed");

      // 3. Fixed promo → integer cents.
      await caller.promos.create({
        tenantId: TENANT_ID,
        promo: { code: "MEDFIX", type: "fixed", value: 500 },
      });
      const fix = erp.calls.filter((c) => c.method === "POST" && c.body?.code === "MEDFIX").pop();
      assert(fix?.body?.application_method?.type === "fixed", "fixed type");
      assert(fix?.body?.application_method?.value === 50000, `fixed → integer cents (got ${fix?.body?.application_method?.value})`);

      // 4. Delete → DELETE /admin/promotions/{id}.
      await caller.promos.delete({ tenantId: TENANT_ID, code: "MED20" });
      const dels = erp.calls.filter((c) => c.url.endsWith("/admin/promotions/prom_j529") && c.method === "DELETE");
      assert(dels.length === 1, "remote promotion deleted");
    } finally {
      erp.handlers.delete(HOST);
      await world.db.delete(schema.tenantIntegrations)
        .where(and(eq(schema.tenantIntegrations.tenantId, TENANT_ID), eq(schema.tenantIntegrations.integrationType, "medusa")))
        .catch(() => {});
      await world.patchTenantSettings({ promos: (before as any)?.promos ?? [] });
    }
  },
};
