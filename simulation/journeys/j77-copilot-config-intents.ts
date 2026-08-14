/**
 * J77 — Ongoing copilot configuration intents (W15 F5).
 *
 * applyCopilotConfig via the REAL erpProvision router (operatorProcedure):
 *   1. Without confirm → dry-run preview only; tenant settings untouched.
 *   2. With confirm → settings applied + audit entries
 *      (erp_provision.config.<intent>); covers set_low_stock_threshold,
 *      set_delivery_zones (upsert), set_pipeline_stages, toggle_catalog_sync.
 *   3. Idempotency: re-applying the same intent is a changed:false no-op
 *      (still audit-logged for traceability).
 *   4. Access gating: an analyst membership is FORBIDDEN on applyConfig AND
 *      on provision; validation junk is BAD_REQUEST.
 */
import { eq, like } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J77",
  name: "copilot ongoing config intents",
  feature: "preview vs confirm + audit + operator gating",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const settingsBefore = await world.tenantSettings();

    // Memberships drive operatorProcedure: uid 42 = operator, 43 = analyst.
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId: TENANT_ID, userId: "42", role: "operator" },
      { tenantId: TENANT_ID, userId: "43", role: "analyst" },
    ]);
    const operator = await tenantCaller(TENANT_ID, { userId: 42 });
    const analyst = await tenantCaller(TENANT_ID, { userId: 43 });

    const auditCount = async (intent: string) =>
      (
        await world.db
          .select()
          .from(schema.auditLogs)
          .where(like(schema.auditLogs.action, `erp_provision.config.${intent}`))
      ).length;

    try {
      // ── 1. Preview-only without confirm ──────────────────────────────────
      const preview1 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_low_stock_threshold",
        params: { threshold: 9 },
        confirm: false,
      });
      assert(preview1.dryRun === true && preview1.changed === true, "preview reports the pending change");
      assert(preview1.before === 3 && preview1.after === 9, `before/after accurate (${preview1.before}→${preview1.after})`);
      const preview2 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_pipeline_stages",
        params: { stages: ["lead", "qualified", "won"] },
        // confirm omitted entirely — default is a dry-run
      });
      assert(preview2.dryRun === true, "omitted confirm is a dry-run");
      const preview3 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_delivery_zones",
        params: {
          zones: [
            { name: "Lagos metro", fee: 1500, etaMinutes: 45 },
            { name: "Abuja express", fee: 3500, etaMinutes: 1440 },
          ],
          mode: "replace",
        },
        confirm: false,
      });
      assert(preview3.dryRun === true && preview3.changed === true, "zone replace previewed");
      assert(
        ((await world.tenantSettings()) as any).inventory?.lowStockThreshold === 3,
        "settings untouched by previews",
      );
      assert((await auditCount("set_low_stock_threshold")) === 0, "previews are NOT audit-logged as applied");

      // ── 2. Confirmed intents apply + audit ───────────────────────────────
      const applied1 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_low_stock_threshold",
        params: { threshold: 9 },
        confirm: true,
      });
      assert(applied1.dryRun === false && applied1.changed === true, "threshold applied");
      assert(
        ((await world.tenantSettings()) as any).inventory?.lowStockThreshold === 9,
        "settings.inventory.lowStockThreshold persisted",
      );

      // Replace first (the seed zones use the legacy {zone,label} shape that
      // fails the deliveryZoneSchema merge — replace normalizes), then upsert
      // a third zone onto the now-schema-valid list.
      const applied2 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_delivery_zones",
        params: {
          zones: [
            { name: "Lagos metro", fee: 1500, etaMinutes: 45 },
            { name: "Abuja express", fee: 3500, etaMinutes: 1440 },
          ],
          mode: "replace",
        },
        confirm: true,
      });
      assert(applied2.changed === true, "zone replace applied");
      const applied2b = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_delivery_zones",
        params: { zones: [{ name: "Kano standard", fee: 2800, etaMinutes: 2880 }], mode: "upsert" },
        confirm: true,
      });
      assert(applied2b.changed === true, "zone upsert applied after replace");
      const zones = ((await world.tenantSettings()) as any).commerce?.deliveryZones ?? [];
      assert(
        zones.length === 3 &&
          zones.some((z: any) => z.name === "Abuja express" && z.fee === 3500) &&
          zones.some((z: any) => z.name === "Kano standard"),
        `upsert preserved + appended zones (got ${JSON.stringify(zones).slice(0, 240)})`,
      );

      const applied3 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_pipeline_stages",
        params: { stages: ["lead", "qualified", "won"] },
        confirm: true,
      });
      assert(applied3.changed === true, "pipeline stages applied");
      assert(
        JSON.stringify(((await world.tenantSettings()) as any).crm?.pipelineStages) ===
          JSON.stringify(["lead", "qualified", "won"]),
        "pipeline stages persisted",
      );

      // toggle_catalog_sync requires a configured integration first.
      await world.patchTenantSettings({
        integrations: { odoo: { url: "http://odoo-j77.sim.local", apiKey: "k", enabled: true } },
      });
      const applied4 = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "toggle_catalog_sync",
        params: { provider: "odoo", enabled: false },
        confirm: true,
      });
      assert(applied4.changed === true && applied4.before === true && applied4.after === false, "catalog sync toggled off");
      assert(
        ((await world.tenantSettings()) as any).integrations?.odoo?.enabled === false,
        "integration disabled in settings",
      );

      for (const [intent, n] of [
        ["set_low_stock_threshold", 1],
        ["set_delivery_zones", 2], // replace + upsert
        ["set_pipeline_stages", 1],
        ["toggle_catalog_sync", 1],
      ] as const) {
        assert((await auditCount(intent)) === n, `audit entries for ${intent}`);
      }

      // ── 3. Idempotent re-apply: changed:false no-op, still audited ───────
      const noop = await operator.erpProvision.applyConfig({
        tenantId: TENANT_ID,
        intent: "set_low_stock_threshold",
        params: { threshold: 9 },
        confirm: true,
      });
      assert(noop.dryRun === false && noop.changed === false, "re-apply is a no-op");
      assert((await auditCount("set_low_stock_threshold")) === 2, "no-op still audit-logged for traceability");

      // ── 4. Access + validation gating ────────────────────────────────────
      await expectTrpcError(
        analyst.erpProvision.applyConfig({
          tenantId: TENANT_ID,
          intent: "set_low_stock_threshold",
          params: { threshold: 1 },
          confirm: true,
        }),
        "FORBIDDEN",
        "analyst cannot apply config",
      );
      await expectTrpcError(
        analyst.erpProvision.provision({ tenantId: TENANT_ID, dryRun: true }),
        "FORBIDDEN",
        "analyst cannot provision",
      );
      await expectTrpcError(
        operator.erpProvision.applyConfig({
          tenantId: TENANT_ID,
          intent: "set_pipeline_stages",
          params: { stages: ["only_one"] },
          confirm: true,
        }),
        "BAD_REQUEST",
        "zod rejects <2 pipeline stages",
      );
      await expectTrpcError(
        operator.erpProvision.applyConfig({
          tenantId: TENANT_ID,
          intent: "toggle_catalog_sync",
          params: { provider: "twenty", enabled: false },
          confirm: true,
        }),
        "BAD_REQUEST",
        "toggle for an unconfigured integration fails honestly",
      );
      assert(
        ((await world.tenantSettings()) as any).inventory?.lowStockThreshold === 9,
        "rejected/forbidden calls mutated nothing",
      );
    } finally {
      // Restore the full seed settings snapshot (inventory/commerce/crm/
      // integrations mutated above; memberships are wiped by resetJourneyState).
      await world.db
        .update(schema.tenants)
        .set({ settings: settingsBefore, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
      await world.db.delete(schema.tenantMemberships).where(eq(schema.tenantMemberships.tenantId, TENANT_ID)).catch(() => {});
    }
  },
};
